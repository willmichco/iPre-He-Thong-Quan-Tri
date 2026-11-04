/**
 * Chuyến hàng · Đơn mua · Máy — phần thuần dùng được ở trình duyệt (không kéo theo zod): nhãn trạng thái, mã chuyến,
 * hạn đổi trả, đọc bảng dán từ Excel/Google Sheets, kiểm tra lưới nhập máy (tài liệu 07 mục 6.2–6.4).
 * purchasing.ts tái xuất toàn bộ, nên phía máy chủ vẫn nhập từ "@/domain/purchasing" như cũ.
 */
import { parseDecimalInput } from "./decimal-input";
import { classifyCode, isPartNumber, isSerialFormat, isValidImei, normalizeCode, partNumberRegion } from "./identifiers";

// ---- Nhãn trạng thái ------------------------------------------------------------------------------------

export const BATCH_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Nháp",
  PURCHASING: "Đang mua",
  IN_TRANSIT: "Đang vận chuyển",
  ARRIVED: "Đã về",
  COSTS_FINALIZED: "Đã chốt chi phí",
  CLOSED: "Đã đóng",
};

export const ITEM_STATUS_LABEL: Record<string, string> = {
  ORDERED: "Đã đặt",
  US_IN_TRANSIT: "Ship nội địa Mỹ",
  AT_US_WAREHOUSE: "Kho Mỹ",
  INTL_IN_TRANSIT: "Mỹ → VN",
  AT_HN: "Tại HN",
  DOMESTIC_IN_TRANSIT: "HN → SG",
  IN_STOCK: "Tồn kho SG",
  RESERVED: "Khách cọc",
  SOLD: "Đã bán",
  RETURNED_TO_SELLER: "Trả người bán",
  WARRANTY: "Bảo hành",
  LOST: "Thất lạc",
  DAMAGED: "Hư hỏng",
  PERSONAL_USE: "Dùng cá nhân",
};

export const CONDITIONS = ["NEW_SEALED", "OPEN_BOX", "LIKE_NEW", "USED", "REFURBISHED"] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string> = {
  NEW_SEALED: "Mới seal",
  OPEN_BOX: "Mở hộp",
  LIKE_NEW: "Như mới",
  USED: "Đã dùng",
  REFURBISHED: "Refurbished",
};

// ---- Mã chuyến ------------------------------------------------------------------------------------------

/** Mã chuyến kế tiếp trong năm: CH-2026-011 → CH-2026-012 (bỏ qua mã không đúng mẫu). */
export function nextBatchCode(year: number, existing: readonly string[]): string {
  const re = new RegExp(`^CH-${year}-(\\d+)$`);
  const max = existing.reduce((m, c) => Math.max(m, Number(re.exec(c)?.[1] ?? 0)), 0);
  return `CH-${year}-${String(max + 1).padStart(3, "0")}`;
}

/** Hạn đổi trả = ngày đặt + số ngày đổi trả của nơi mua (khi người dùng để trống). */
export function returnDeadlineFrom(orderedAt: string, returnDays: number | null): string | null {
  if (returnDays === null) return null;
  const d = new Date(`${orderedAt}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + returnDays);
  return d.toISOString().slice(0, 10);
}

// ---- Lưới nhập máy --------------------------------------------------------------------------------------

/** Một dòng trong lưới — mọi ô là chuỗi người dùng gõ / dán / quét. */
export interface GridRow {
  /** id máy đã lưu; trống = dòng mới */
  id?: string;
  variantId: string;
  unitPrice: string;
  serial: string;
  imei1: string;
  imei2: string;
  partNumber: string;
  modelNumber: string;
  condition: string;
  weightKg: string;
  note: string;
}

export const GRID_FIELDS = ["variantId", "unitPrice", "serial", "imei1", "imei2", "partNumber", "modelNumber", "condition", "weightKg", "note"] as const;
export type GridField = (typeof GRID_FIELDS)[number];

export const emptyRow = (): GridRow => ({
  variantId: "",
  unitPrice: "",
  serial: "",
  imei1: "",
  imei2: "",
  partNumber: "",
  modelNumber: "",
  condition: "NEW_SEALED",
  weightKg: "",
  note: "",
});

export const isBlankRow = (r: GridRow) => !r.id && GRID_FIELDS.every((f) => f === "condition" || !r[f].trim());

/** Cấu hình để tra cứu khi nhập: id, tên hiển thị, SKU, các mã trên hộp. */
export interface VariantRef {
  id: string;
  label: string;
  sku: string;
  codes: string[];
  defaultWeightKg: string | null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/**
 * Gõ tắt cấu hình: "pm 256 sil" → iPhone Pro Max · 256GB · Silver. Mỗi từ gõ phải là đầu của một từ trong tên
 * hoặc SKU; gõ đúng Part No./SKU thì khớp ngay. Trả null khi không khớp hoặc khớp nhiều cấu hình ngang nhau.
 */
export function matchVariant(query: string, variants: readonly VariantRef[]): VariantRef | null {
  const q = fold(query).trim();
  if (!q) return null;
  const code = normalizeCode(query);
  const exact = variants.find((v) => v.sku === code || v.codes.includes(code) || fold(v.label) === q);
  if (exact) return exact;
  const tokens = q.split(/[\s·,/]+/).filter(Boolean);
  const scored = variants
    .map((v) => {
      const nameWords = fold(v.label)
        .split(/[\s·,/-]+/)
        .filter(Boolean);
      const words = [
        ...nameWords,
        ...fold(v.sku)
          .split(/[\s-]+/)
          .filter(Boolean),
      ];
      // chữ cái đầu của 2–4 từ liền nhau: "pro max" → "pm", "iphone pro max" → "ipm"
      const acronyms = new Set<string>();
      for (let i = 0; i < nameWords.length; i++)
        for (let n = 2; n <= 4 && i + n <= nameWords.length; n++)
          acronyms.add(
            nameWords
              .slice(i, i + n)
              .map((w) => w[0])
              .join(""),
          );
      let score = 0;
      for (const t of tokens) {
        const hit = words.find((w) => w.startsWith(t) || (t.length >= 3 && w.includes(t)));
        if (hit) score += hit === t ? 3 : hit.startsWith(t) ? 2 : 1;
        else if (acronyms.has(t)) score += 2;
        else return null;
      }
      return { v, raw: score, extra: words.length };
    })
    .filter((x): x is { v: VariantRef; raw: number; extra: number } => x !== null)
    // điểm khớp cao hơn trước; bằng nhau thì tên ít từ thừa hơn (sát ý người gõ hơn)
    .sort((a, b) => b.raw - a.raw || a.extra - b.extra);
  if (!scored.length) return null;
  const [best, second] = scored;
  if (second && best.raw === second.raw && (tokens.length < 2 || best.extra === second.extra)) return null; // mơ hồ
  return best.v;
}

/** Tiêu đề cột Excel → ô của lưới (tiếng Việt / Anh, không dấu, không phân biệt hoa thường). */
const HEADER_MAP: [RegExp, GridField][] = [
  [/^(cau hinh|model|may|san pham|product|sku|ten may|dong may)/, "variantId"],
  [/^(don gia|gia mua|gia|price|unit price|cost)/, "unitPrice"],
  [/^(imei ?2|imei2)/, "imei2"],
  [/^(imei ?1|imei)/, "imei1"],
  [/^(serial|so serial|so se ?ri|sn)/, "serial"],
  [/^(part|ma may|part no|part number|pn)/, "partNumber"],
  [/^(model number|so hieu|kieu may|a\d{4})/, "modelNumber"],
  [/^(tinh trang|condition)/, "condition"],
  [/^(can nang|kg|weight)/, "weightKg"],
  [/^(ghi chu|note)/, "note"],
];

function headerField(cell: string): GridField | null {
  const c = fold(cell)
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim();
  return HEADER_MAP.find(([re]) => re.test(c))?.[1] ?? null;
}

const CONDITION_WORDS: [RegExp, Condition][] = [
  [/^(moi|new|seal|nguyen seal|moi seal)/, "NEW_SEALED"],
  [/^(mo hop|open)/, "OPEN_BOX"],
  [/^(nhu moi|like)/, "LIKE_NEW"],
  [/^(da dung|used|cu)/, "USED"],
  [/^(refurb|tan trang|cpo)/, "REFURBISHED"],
];
const STORAGE_SIZES = new Set(["1", "2", "4", "8", "16", "32", "64", "128", "256", "512", "1024"]);
/** một từ đứng riêng chắc chắn là tình trạng máy (khi dán văn bản không có cột) */
const CONDITION_TOKEN = /^(new|seal|moi|used|refurb|refurbished|openbox|likenew|cpo)$/;
export function parseCondition(s: string): Condition | null {
  const c = fold(s).trim();
  if ((CONDITIONS as readonly string[]).includes(s.trim().toUpperCase())) return s.trim().toUpperCase() as Condition;
  return CONDITION_WORDS.find(([re]) => re.test(c))?.[1] ?? null;
}

export interface PasteResult {
  rows: GridRow[];
  /** true = đã nhận ra dòng tiêu đề và xếp cột theo tiêu đề */
  usedHeader: boolean;
  /** ô không xếp được vào đâu (dòng, nội dung) */
  unplaced: { row: number; text: string }[];
}

/**
 * Đọc bảng dán từ Excel / Google Sheets / văn bản.
 * - Có dòng tiêu đề (IMEI, Serial, Đơn giá…) → xếp theo cột.
 * - Không có → tự nhận từng ô: IMEI (Luhn), Serial, Part No., số tiền, tình trạng, còn lại thử khớp cấu hình.
 */
export function parsePastedGrid(text: string, variants: readonly VariantRef[]): PasteResult {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], usedHeader: false, unplaced: [] };
  // Excel/Sheets dán ra dạng tab; văn bản thường: tách theo dấu cách, ; hoặc |
  const split = (l: string) => (l.includes("\t") ? l.split("\t") : l.split(/[\s;|]+/)).map((c) => c.trim());
  const first = split(lines[0]);
  const headerCols = first.map(headerField);
  const usedHeader = headerCols.filter(Boolean).length >= 2 && !first.some((c) => classifyCode(c).kind === "IMEI");
  const body = usedHeader ? lines.slice(1) : lines;
  const unplaced: PasteResult["unplaced"] = [];

  const rows = body.map((line, k) => {
    const cells = split(line);
    const row = emptyRow();
    const put = (f: GridField, v: string) => {
      if (!v) return;
      if (f === "variantId") {
        const m = matchVariant(v, variants);
        if (m) row.variantId = m.id;
        else unplaced.push({ row: k, text: v });
      } else if (f === "condition") row.condition = parseCondition(v) ?? row.condition;
      else if (f === "imei1" && row.imei1) row.imei2 = v;
      else row[f] = v;
    };
    if (usedHeader) {
      cells.forEach((c, i) => {
        const f = headerCols[i];
        if (f) put(f, c);
        else if (c) unplaced.push({ row: k, text: c });
      });
    } else {
      const rest: string[] = [];
      const numbers: string[] = [];
      for (const c of cells) {
        if (!c) continue;
        const code = classifyCode(c);
        if (code.kind === "IMEI") put("imei1", code.value);
        else if (code.kind === "PART_NUMBER") {
          row.partNumber = code.value;
          const m = matchVariant(code.value, variants);
          if (m && !row.variantId) row.variantId = m.id;
        } else if (/^[$]?\d{1,3}([.,]\d{3})*([.,]\d{1,2})?$|^[$]?\d+([.,]\d{1,2})?$/.test(c)) numbers.push(c);
        else if (code.kind === "SERIAL" && /[A-Z]/.test(code.value) && !row.serial) row.serial = code.value;
        else if (CONDITION_TOKEN.test(fold(c))) row.condition = parseCondition(c)!;
        else rest.push(c);
      }
      // đơn giá: số có "$" hoặc phần lẻ, rồi số không giống dung lượng (64/128/256/512…), cuối cùng số sau cùng;
      // các số còn lại thuộc tên cấu hình ("pm 256 sil")
      if (numbers.length) {
        const price = numbers.find((n) => /[$.,]/.test(n)) ?? numbers.find((n) => !STORAGE_SIZES.has(n)) ?? numbers[numbers.length - 1];
        row.unitPrice = price;
        rest.unshift(...numbers.filter((n) => n !== price));
      }
      // phần chữ còn lại (vd "pm 256 sil") → thử khớp cấu hình
      if (rest.length) {
        const m = row.variantId ? null : matchVariant(rest.join(" "), variants);
        if (m) row.variantId = m.id;
        else unplaced.push({ row: k, text: rest.join(" ") });
      }
    }
    // Part No. có trong danh mục → tự điền cấu hình
    if (!row.variantId && row.partNumber) row.variantId = matchVariant(row.partNumber, variants)?.id ?? "";
    return row;
  });
  return { rows, usedHeader, unplaced };
}

/** Máy đã lưu (cho bước kiểm tra trùng trong toàn hệ thống). */
export interface CleanItem {
  id?: string;
  variantId: string;
  unitPrice: string;
  serial: string | null;
  imei1: string | null;
  imei2: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  condition: Condition;
  weightKg: string | null;
  note: string | null;
}

export interface RowIssue {
  row: number;
  field: GridField | null;
  message: string;
  severity: "error" | "warn";
}

/**
 * Kiểm tra cả lưới: bỏ dòng trống; lỗi đỏ (chặn lưu) và cảnh báo vàng (vẫn lưu được).
 * `expectedRegion` = hậu tố thị trường mong đợi của Part No. (hàng Mỹ: LL/A).
 */
export function validateGrid(
  rows: readonly GridRow[],
  variants: readonly VariantRef[],
  expectedRegion: string | null = "LL/A",
): { items: (CleanItem & { row: number })[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const items: (CleanItem & { row: number })[] = [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  const seen = new Map<string, number>();
  rows.forEach((r, row) => {
    if (isBlankRow(r)) return;
    const err = (field: GridField | null, message: string) => issues.push({ row, field, message, severity: "error" });
    const warn = (field: GridField | null, message: string) => issues.push({ row, field, message, severity: "warn" });

    const variant = byId.get(r.variantId);
    if (!variant) err("variantId", "Chọn cấu hình máy");
    const price = parseDecimalInput(r.unitPrice, 2);
    if (r.unitPrice.trim() === "") err("unitPrice", "Nhập đơn giá");
    else if (price === null || price.startsWith("-")) err("unitPrice", "Đơn giá không hợp lệ");

    const serial = normalizeCode(r.serial) || null;
    if (serial && !isSerialFormat(serial)) warn("serial", "Serial Apple thường có 10 hoặc 12 ký tự — soát lại");
    const imeis: [GridField, string | null][] = [
      ["imei1", normalizeCode(r.imei1) || null],
      ["imei2", normalizeCode(r.imei2) || null],
    ];
    for (const [f, v] of imeis) if (v && !isValidImei(v)) err(f, "IMEI sai (phải đủ 15 số, đúng số kiểm tra)");
    if (imeis[0][1] && imeis[0][1] === imeis[1][1]) err("imei2", "IMEI 2 trùng IMEI 1");

    const part = normalizeCode(r.partNumber).replace(/^1P(?=[A-Z0-9]{5}[A-Z]{1,2}\/A$)/, "") || null;
    if (part && !isPartNumber(part)) warn("partNumber", "Không giống Part No. của Apple (vd: MDEM1LL/A)");
    const region = part ? partNumberRegion(part) : null;
    if (region && expectedRegion && region !== expectedRegion) warn("partNumber", `Thị trường ${region}, không phải ${expectedRegion}`);
    if (part && variant && variant.codes.length && !variant.codes.includes(part)) {
      const other = variants.find((v) => v.codes.includes(part));
      if (other) warn("partNumber", `Part No. này thuộc cấu hình ${other.label}`);
    }

    for (const [f, v] of [["serial", serial], ...imeis] as [GridField, string | null][]) {
      if (!v) continue;
      const prev = seen.get(v);
      if (prev !== undefined) err(f, `Trùng với dòng ${prev + 1}`);
      else seen.set(v, row);
    }

    const condition = parseCondition(r.condition);
    if (!condition) err("condition", "Tình trạng không hợp lệ");
    let weight: string | null = null;
    if (r.weightKg.trim()) {
      weight = parseDecimalInput(r.weightKg, 3);
      if (weight === null || !(Number(weight) > 0)) err("weightKg", "Cân nặng không hợp lệ");
    } else if (variant && !variant.defaultWeightKg) warn("weightKg", "Chưa có cân nặng (cấu hình cũng chưa có) — cần khi chia cước theo kg");

    if (!issues.some((i) => i.row === row && i.severity === "error"))
      items.push({
        row,
        id: r.id,
        variantId: r.variantId,
        unitPrice: price!,
        serial,
        imei1: imeis[0][1],
        imei2: imeis[1][1],
        partNumber: part,
        modelNumber: normalizeCode(r.modelNumber) || null,
        condition: condition!,
        weightKg: weight,
        note: r.note.trim() || null,
      });
  });
  return { items, issues };
}

/** Σ đơn giá các dòng hợp lệ (chuỗi số 2 chữ số thập phân) — để so với subtotal hoá đơn. */
export function sumPrices(rows: readonly GridRow[]): string {
  let cents = 0n;
  for (const r of rows) {
    const p = parseDecimalInput(r.unitPrice, 2);
    if (p && !p.startsWith("-")) cents += BigInt(p.replace(".", ""));
  }
  const s = cents.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
