/**
 * Sổ quỹ (Thu chi) — hàm thuần, không phụ thuộc CSDL / zod (dùng được ở cả trình duyệt).
 *
 * Tiền trong sổ quỹ lưu theo TIỀN TỆ CỦA TÀI KHOẢN (numeric(16,2)) kèm số quy đổi VND (bigint) để báo cáo.
 * Ở đây mọi phép tính dùng "xu" (cents, bigint = số tiền × 100) để không bao giờ lệch do số thực.
 *
 * Nguyên tắc (tài liệu 01 mục 9):
 * - Bút toán TỰ SINH (đơn mua, chi phí theo chặng, tiền bán hàng, chi phí bán hàng) chỉ sửa ở chứng từ gốc.
 * - Người dùng nhập tay: chi phí vận hành, thu khác, góp / rút vốn, nộp thuế, chuyển tiền nội bộ.
 * - Chuyển tiền / đổi ngoại tệ = 2 bút toán cùng nhóm, không ảnh hưởng lãi lỗ.
 * - Trả tiền mua hàng là dòng tiền ra nhưng CHƯA phải chi phí — nó thành giá vốn khi máy được bán.
 */
import { parseDecimalInput, parseFxRate } from "./decimal-input";
import { parseVndInput } from "./sales-core";

export type Currency = "VND" | "USD";
export type Direction = "IN" | "OUT";

/** Danh mục hệ thống nhưng vẫn cho nhập tay (không gắn chứng từ nào). */
export const MANUAL_SYSTEM_CODES = ["CAPITAL_IN", "CAPITAL_OUT", "TAX"] as const;
/** Danh mục do hệ thống tự ghi — không chọn được khi nhập tay. */
export const AUTO_CODES = [
  "PURCHASE",
  "LANDED_COST",
  "LANDED_COST_REFUND",
  "SALE_DEPOSIT",
  "SALE_RECEIPT",
  "SALE_REFUND",
  "SALE_EXPENSE",
  "SELLER_REFUND",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "ADJUST_IN",
  "ADJUST_OUT",
] as const;

export function isManualCategory(c: { code: string; isSystem: boolean }): boolean {
  return !c.isSystem || (MANUAL_SYSTEM_CODES as readonly string[]).includes(c.code);
}

export type SourceType = "PURCHASE_ORDER" | "COST" | "SALE" | "SALE_EXPENSE" | "TRANSFER" | "ADJUSTMENT" | "MANUAL";

export const SOURCE_LABEL: Record<SourceType, string> = {
  PURCHASE_ORDER: "Đơn mua",
  COST: "Chi phí chặng",
  SALE: "Đơn bán",
  SALE_EXPENSE: "Chi phí bán hàng",
  TRANSFER: "Chuyển tiền",
  ADJUSTMENT: "Điều chỉnh đối soát",
  MANUAL: "Nhập tay",
};

/** Bút toán này đến từ đâu (quyết định có sửa / xoá trực tiếp trong sổ quỹ được không). */
export function sourceOf(t: {
  purchaseOrderId?: string | null;
  costId?: string | null;
  saleId?: string | null;
  saleExpenseId?: string | null;
  transferGroupId?: string | null;
  categoryCode: string;
}): SourceType {
  if (t.purchaseOrderId) return "PURCHASE_ORDER";
  if (t.costId) return "COST";
  if (t.saleExpenseId) return "SALE_EXPENSE";
  if (t.saleId) return "SALE";
  if (t.transferGroupId) return "TRANSFER";
  if (t.categoryCode === "ADJUST_IN" || t.categoryCode === "ADJUST_OUT") return "ADJUSTMENT";
  return "MANUAL";
}

/** Chỉ bút toán nhập tay sửa được trong sổ quỹ; chuyển tiền xoá được cả cặp. */
export const editableSource = (s: SourceType) => s === "MANUAL";
export const deletableSource = (s: SourceType) => s === "MANUAL" || s === "TRANSFER" || s === "ADJUSTMENT";

// ---- Tiền (xu) ------------------------------------------------------------------------------------------

/** "123.45" · "-5" · "1234.5" (dạng numeric của PostgreSQL) → xu. */
export function toCents(s: string): bigint {
  const t = s.trim();
  const neg = t.startsWith("-");
  const [i, f = ""] = (neg ? t.slice(1) : t).split(".");
  if (!/^\d+$/.test(i || "0") || !/^\d*$/.test(f) || f.length > 2) throw new Error(`Số tiền không hợp lệ: ${s}`);
  const v = BigInt(i || "0") * 100n + BigInt(f.padEnd(2, "0") || "0");
  return neg ? -v : v;
}

/** Xu → chuỗi numeric "123.45" (ghi CSDL). */
export function centsToDecimal(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/**
 * Số tiền người dùng gõ, theo tiền tệ tài khoản → xu (> 0). VND hiểu `2tr`, `500k`, `2.000.000`;
 * USD hiểu `1,199.00`, `1.199,00`, `$20`. Không hợp lệ / ≤ 0 → null.
 */
export function parseAmount(raw: string, currency: Currency): bigint | null {
  if (currency === "VND") {
    const v = parseVndInput(raw);
    return v !== null && v > 0n ? v * 100n : null;
  }
  const d = parseDecimalInput(raw, 2);
  if (d === null) return null;
  const c = toCents(d);
  return c > 0n ? c : null;
}

/** Số dư thực tế (được âm hoặc 0; VND chấp nhận đuôi ",00") → xu; không đọc được → null. */
export function parseBalance(raw: string, currency: Currency): bigint | null {
  let s = raw.trim().replace(/^−/, "-");
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1).trim();
  if (!s) return null;
  let c: bigint | null;
  if (currency === "VND") {
    const v = parseVndInput(s.replace(/[.,]00$/, ""));
    c = v === null ? null : v * 100n;
  } else {
    const d = parseDecimalInput(s, 2);
    c = d === null ? null : toCents(d);
  }
  return c === null ? null : neg ? -c : c;
}

/** Tỷ giá gõ tay "26.350" / "26350" / "26,350.5" → chuỗi numeric; ≤ 0 → null. */
export function parseRate(raw: string): string | null {
  const d = parseFxRate(raw);
  return d !== null && Number(d) > 0 ? d : null;
}

/** USD (xu) × tỷ giá → VND (làm tròn như PostgreSQL round: nửa xa số 0). */
export function vndFromUsdCents(cents: bigint, rate: string): bigint {
  const r = toRate(rate); // tỷ giá × 10^4
  const num = cents * r; // VND × 10^6
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a + 500_000n) / 1_000_000n;
  return neg ? -q : q;
}

function toRate(s: string): bigint {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10_000n + BigInt(f.padEnd(4, "0").slice(0, 4) || "0");
}

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** 1234567,00 VND → "1.234.567 ₫" · 1234,5 USD → "1.234,50 $". Âm có dấu "−". */
export function formatAmount(cents: bigint, currency: Currency): string {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  const int = group((a / 100n).toString());
  const frac = (a % 100n).toString().padStart(2, "0");
  const body = currency === "VND" ? (frac === "00" ? int : `${int},${frac}`) : `${int},${frac}`;
  return `${neg ? "−" : ""}${body} ${currency === "VND" ? "₫" : "$"}`;
}

// ---- Số dư ----------------------------------------------------------------------------------------------

/** Số dư = đầu kỳ + Σ thu − Σ chi (tất cả theo xu của tiền tệ tài khoản). */
export function balanceOf(openingCents: bigint, txns: readonly { direction: Direction; amountCents: bigint }[]): bigint {
  return txns.reduce((b, t) => (t.direction === "IN" ? b + t.amountCents : b - t.amountCents), openingCents);
}

/** Số dư luỹ kế sau từng bút toán (sổ quỹ một tài khoản, đã xếp theo thời gian tăng dần). */
export function runningBalances(openingCents: bigint, txns: readonly { direction: Direction; amountCents: bigint }[]): bigint[] {
  let b = openingCents;
  return txns.map((t) => (b = t.direction === "IN" ? b + t.amountCents : b - t.amountCents));
}

/** Chênh lệch đối soát: thực tế − hệ thống. Dương = thực tế nhiều hơn (thiếu bút toán thu / thừa bút toán chi). */
export function reconcileDiff(statementCents: bigint, systemCents: bigint) {
  const diff = statementCents - systemCents;
  return { diff, direction: diff > 0n ? ("IN" as const) : diff < 0n ? ("OUT" as const) : null, amount: diff < 0n ? -diff : diff };
}

// ---- Dòng tiền theo tuần --------------------------------------------------------------------------------

const DAY = 86_400_000;
const parseDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Thứ Hai đầu tuần của một ngày "YYYY-MM-DD". */
export function weekStart(day: string): string {
  const t = parseDay(day);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // 0 = thứ Hai
  return fmtDay(t - dow * DAY);
}

/** n tuần gần nhất (tính cả tuần hiện tại), cũ → mới, mỗi phần tử là ngày thứ Hai. */
export function lastWeeks(today: string, n = 12): string[] {
  const start = parseDay(weekStart(today));
  return Array.from({ length: n }, (_, i) => fmtDay(start - (n - 1 - i) * 7 * DAY));
}

export interface WeekFlow {
  week: string;
  label: string;
  inVnd: bigint;
  outVnd: bigint;
}

/** Điền đủ các tuần (tuần không có giao dịch = 0). Nhãn "dd/mm" của thứ Hai. */
export function fillWeeks(rows: readonly { week: string; inVnd: bigint; outVnd: bigint }[], weeks: readonly string[]): WeekFlow[] {
  const by = new Map(rows.map((r) => [r.week, r]));
  return weeks.map((w) => ({
    week: w,
    label: `${w.slice(8, 10)}/${w.slice(5, 7)}`,
    inVnd: by.get(w)?.inVnd ?? 0n,
    outVnd: by.get(w)?.outVnd ?? 0n,
  }));
}

/** Số ngày từ một ngày tới hôm nay (ngày, không âm). */
export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((parseDay(to) - parseDay(from)) / DAY));
}

/** Tuổi công nợ: ≤ 30 ngày · 31–60 · 61–90 · > 90. */
export function debtAgeBucket(days: number): "0-30" | "31-60" | "61-90" | "90+" {
  return days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
}

// ---- Kiểm tra form --------------------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
/** Ngày thật "YYYY-MM-DD" (30/02 bị từ chối). */
const DATE_RE = { test: (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDay(parseDay(s)) === s };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManualEntryForm {
  accountId: string;
  categoryCode: string;
  amount: string;
  fxRate: string;
  occurredAt: string;
  counterparty: string;
  note: string;
}

export interface ManualEntryInput {
  accountId: string;
  categoryCode: string;
  /** chuỗi gốc, quy đổi theo tiền tệ tài khoản ở lớp dịch vụ */
  amount: string;
  fxRate: string | null;
  occurredAt: string;
  counterparty: string | null;
  note: string | null;
}

/** Kiểm tra phần không phụ thuộc CSDL của bút toán nhập tay (số tiền kiểm sau khi biết tiền tệ tài khoản). */
export function checkManualEntry(f: Partial<ManualEntryForm>): { ok: true; data: ManualEntryInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const s = (k: keyof ManualEntryForm) => String(f[k] ?? "").trim();
  if (!UUID_RE.test(s("accountId"))) errors.accountId = "Chọn tài khoản";
  if (!s("categoryCode")) errors.categoryCode = "Chọn danh mục";
  if (!s("amount")) errors.amount = "Nhập số tiền";
  if (!DATE_RE.test(s("occurredAt"))) errors.occurredAt = "Chọn ngày";
  const rate = s("fxRate");
  if (rate && !parseRate(rate)) errors.fxRate = "Tỷ giá không hợp lệ (vd 26.350)";
  if (s("note").length > 500) errors.note = "Ghi chú tối đa 500 ký tự";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      accountId: s("accountId"),
      categoryCode: s("categoryCode"),
      amount: s("amount"),
      fxRate: rate ? parseRate(rate) : null,
      occurredAt: s("occurredAt"),
      counterparty: s("counterparty") || null,
      note: s("note") || null,
    },
  };
}

export interface TransferForm {
  fromAccountId: string;
  toAccountId: string;
  amountFrom: string;
  amountTo: string;
  fxRate: string;
  occurredAt: string;
  note: string;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountFrom: string;
  /** chỉ dùng khi đổi ngoại tệ (khác tiền tệ); cùng tiền tệ thì = số chuyển đi */
  amountTo: string | null;
  fxRate: string | null;
  occurredAt: string;
  note: string | null;
}

export function checkTransfer(f: Partial<TransferForm>): { ok: true; data: TransferInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const s = (k: keyof TransferForm) => String(f[k] ?? "").trim();
  if (!UUID_RE.test(s("fromAccountId"))) errors.fromAccountId = "Chọn tài khoản chuyển đi";
  if (!UUID_RE.test(s("toAccountId"))) errors.toAccountId = "Chọn tài khoản nhận";
  else if (s("toAccountId") === s("fromAccountId")) errors.toAccountId = "Tài khoản nhận phải khác tài khoản chuyển";
  if (!s("amountFrom")) errors.amountFrom = "Nhập số tiền chuyển";
  if (!DATE_RE.test(s("occurredAt"))) errors.occurredAt = "Chọn ngày";
  const rate = s("fxRate");
  if (rate && !parseRate(rate)) errors.fxRate = "Tỷ giá không hợp lệ (vd 26.350)";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      fromAccountId: s("fromAccountId"),
      toAccountId: s("toAccountId"),
      amountFrom: s("amountFrom"),
      amountTo: s("amountTo") || null,
      fxRate: rate ? parseRate(rate) : null,
      occurredAt: s("occurredAt"),
      note: s("note") || null,
    },
  };
}

/**
 * Hai vế của một lần chuyển tiền (xu theo tiền tệ từng tài khoản) + giá trị VND để báo cáo.
 * - cùng VND: hai vế bằng nhau.
 * - VND ↔ USD (đổi ngoại tệ): vế USD do người dùng nhập, giá trị VND = vế VND (tỷ giá thực tế ngầm định).
 * - cùng USD: cần tỷ giá để quy đổi VND.
 */
export function transferLegs(
  from: { currency: Currency },
  to: { currency: Currency },
  input: { amountFrom: string; amountTo: string | null; fxRate: string | null },
): { ok: true; outCents: bigint; inCents: bigint; vnd: bigint } | { ok: false; errors: FieldErrors } {
  const outCents = parseAmount(input.amountFrom, from.currency);
  if (outCents === null)
    return { ok: false, errors: { amountFrom: from.currency === "VND" ? "Số tiền không hợp lệ (vd 2tr · 500k)" : "Số tiền USD không hợp lệ" } };
  // cùng tiền tệ: hai vế bằng nhau (phí chuyển, nếu có, ghi riêng thành khoản chi vận hành)
  let inCents: bigint | null = outCents;
  if (from.currency !== to.currency) {
    if (!input.amountTo) return { ok: false, errors: { amountTo: `Nhập số ${to.currency} nhận được` } };
    inCents = parseAmount(input.amountTo, to.currency);
    if (inCents === null) return { ok: false, errors: { amountTo: "Số tiền nhận không hợp lệ" } };
  }
  let vnd: bigint;
  if (from.currency === "VND") vnd = outCents / 100n;
  else if (to.currency === "VND") vnd = inCents / 100n;
  else {
    if (!input.fxRate) return { ok: false, errors: { fxRate: "Chuyển giữa hai tài khoản USD: nhập tỷ giá để quy đổi VND" } };
    vnd = vndFromUsdCents(outCents, input.fxRate);
  }
  if (vnd <= 0n) return { ok: false, errors: { amountFrom: "Số tiền quá nhỏ" } };
  return { ok: true, outCents, inCents, vnd };
}
