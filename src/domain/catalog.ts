/**
 * Danh mục — kiểm tra dữ liệu nhập tay (tài liệu 07 mục 6.2) và các tiện ích thuần: gợi ý mã SKU, chuẩn hoá mã
 * Part No./UPC/EAN, đọc số kiểu Việt Nam ("0,6"). Không đụng CSDL — dùng chung cho form, dịch vụ và kiểm thử.
 */
import { z } from "zod";
import { isPartNumber, isValidEan13, isValidUpcA, normalizeCode, partNumberRegion } from "./identifiers";

export const CATEGORIES = ["IPHONE", "IPAD", "MAC", "AIRPODS", "WATCH", "ACCESSORY", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  IPHONE: "iPhone",
  IPAD: "iPad",
  MAC: "Mac",
  AIRPODS: "AirPods",
  WATCH: "Apple Watch",
  ACCESSORY: "Phụ kiện",
  OTHER: "Khác",
};

export const SUPPLIER_KINDS = ["RETAILER", "MARKETPLACE", "INDIVIDUAL", "OTHER"] as const;
export const SUPPLIER_KIND_LABEL: Record<(typeof SUPPLIER_KINDS)[number], string> = {
  RETAILER: "Cửa hàng bán lẻ",
  MARKETPLACE: "Sàn TMĐT",
  INDIVIDUAL: "Cá nhân",
  OTHER: "Khác",
};

export const LEG_TYPES = ["US_DOMESTIC", "US_TO_VN", "HN_TO_SG", "SG_LOCAL", "OTHER"] as const;
export type LegType = (typeof LEG_TYPES)[number];
export const LEG_LABEL: Record<LegType, string> = {
  US_DOMESTIC: "① Nội địa Mỹ",
  US_TO_VN: "② Mỹ → VN",
  HN_TO_SG: "③ HN → SG",
  SG_LOCAL: "Nội thành SG",
  OTHER: "Khác",
};

export const ACCOUNT_KINDS = ["CASH", "BANK", "CARD", "EWALLET", "OTHER"] as const;
export const ACCOUNT_KIND_LABEL: Record<(typeof ACCOUNT_KINDS)[number], string> = {
  CASH: "Tiền mặt",
  BANK: "Ngân hàng",
  CARD: "Thẻ",
  EWALLET: "Ví điện tử",
  OTHER: "Khác",
};

export const CODE_TYPES = ["PART_NUMBER", "UPC", "EAN"] as const;
export type CodeType = (typeof CODE_TYPES)[number];

// ---- Số kiểu Việt Nam ----------------------------------------------------------------------------------

/**
 * Đọc số thập phân người dùng gõ: "0,6" · "0.6" · "1.199,00" · "1,199.00" · "$1,199" → chuỗi chuẩn "1199.00".
 * Trả null nếu không phải số hoặc quá `scale` chữ số thập phân.
 */
export function parseDecimalInput(raw: string, scale: number): string | null {
  let s = raw.trim().replace(/[\s$₫đ]/gi, "");
  if (!s) return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let intPart: string;
  let frac = "";
  if (lastDot >= 0 && lastComma >= 0) {
    // dấu xuất hiện sau cùng là dấu thập phân, dấu còn lại là phân cách hàng nghìn
    const dec = lastDot > lastComma ? "." : ",";
    const group = dec === "." ? "," : ".";
    const [i, f] = [s.slice(0, s.lastIndexOf(dec)), s.slice(s.lastIndexOf(dec) + 1)];
    const groups = i.split(group);
    // phần nguyên chỉ được chứa dấu hàng nghìn, mỗi nhóm sau nhóm đầu đúng 3 chữ số
    if (i.includes(dec) || groups.slice(1).some((g) => g.length !== 3)) return null;
    intPart = groups.join("");
    frac = f;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    // "1.199" / "1,199": nhiều nhóm, hoặc đúng 3 chữ số sau dấu mà số thập phân cho phép < 3 → hàng nghìn
    // (USD "1,199" = 1199; cân nặng "1,199" kg = 1,199) ; còn lại → thập phân
    const thousands = parts.length > 2 || (scale < 3 && parts[0] !== "0" && parts.slice(1).every((p) => p.length === 3));
    if (thousands) {
      if (parts.slice(1).some((p) => p.length !== 3)) return null;
      intPart = parts.join("");
    } else {
      intPart = parts[0];
      frac = parts[1];
    }
  } else intPart = s;
  if (!/^\d+$/.test(intPart || "0") || !/^\d*$/.test(frac)) return null;
  if (frac.length > scale) return null;
  const int = (intPart || "0").replace(/^0+(?=\d)/, "");
  const out = scale ? `${int}.${frac.padEnd(scale, "0")}` : int;
  return neg ? `-${out}` : out;
}

// ---- Mã SKU -----------------------------------------------------------------------------------------------

const TOKEN_ABBR: Record<string, string> = {
  IPHONE: "IP",
  IPAD: "IPAD",
  AIRPODS: "AP",
  MACBOOK: "MB",
  IMAC: "IMAC",
  MAC: "MAC",
  WATCH: "AW",
  APPLE: "",
  PRO: "P",
  MAX: "M",
  PLUS: "PL",
  MINI: "MINI",
  AIR: "AIR",
  ULTRA: "U",
  SE: "SE",
  STUDIO: "ST",
};

function abbrWord(w: string): string {
  const u = w.toUpperCase();
  // chữ cái đầu + các phụ âm, đủ 3 ký tự thì dừng (Silver → SLV, Blue → BLU, White → WHT)
  const consonants = u[0] + u.slice(1).replace(/[AEIOUY]/g, "");
  return (consonants.length >= 3 ? consonants : (consonants + u.slice(1).replace(/[^AEIOUY]/g, "")).slice(0, 3)).slice(0, 3);
}

const clean = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .trim();

/** "iPhone Pro Max" + 256GB + Silver → "IPPM-256-SLV" (gợi ý; người dùng sửa được). */
export function suggestSku(modelName: string, v: { storage?: string | null; color?: string | null; chip?: string | null; memory?: string | null }): string {
  const model = clean(modelName)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t in TOKEN_ABBR ? TOKEN_ABBR[t] : /^\d+$/.test(t) ? t : t.slice(0, 3)))
    .join("");
  const storage = (s: string) => clean(s).replace(/\s+/g, "").replace(/GB$/, "").replace(/TB$/, "T");
  const color = (c: string) => {
    const words = clean(c).split(/\s+/).filter(Boolean);
    return words.length > 1 ? words.map((w) => w[0]).join("") : abbrWord(words[0] ?? "");
  };
  const parts = [model || "SP"];
  if (v.chip) parts.push(clean(v.chip).replace(/\s+/g, ""));
  if (v.memory) parts.push(storage(v.memory));
  if (v.storage) parts.push(storage(v.storage));
  if (v.color) parts.push(color(v.color));
  if (parts.length === 1) parts.push("STD");
  return parts.filter(Boolean).join("-");
}

// ---- Mã trên hộp ------------------------------------------------------------------------------------------

/** Đoán loại mã người dùng gõ / quét: Part No. (kể cả tiền tố "1P"), UPC 12 số, EAN 13 số; không rõ → null. */
export function classifyCodeType(raw: string): CodeType | null {
  const c = normalizeCode(raw).replace(/\s+/g, "");
  if (isPartNumber(c) || (c.startsWith("1P") && isPartNumber(c.slice(2)))) return "PART_NUMBER";
  if (/^\d{12}$/.test(c)) return "UPC";
  if (/^\d{13}$/.test(c)) return "EAN";
  return null;
}

export type CodeCheck = { ok: true; code: string; region: string | null } | { ok: false; error: string };

/** Chuẩn hoá & kiểm tra mã theo loại; Part No. trả kèm hậu tố thị trường (LL/A…). */
export function checkVariantCode(type: CodeType, raw: string): CodeCheck {
  let code = normalizeCode(raw).replace(/\s+/g, "");
  if (type === "PART_NUMBER") {
    if (code.startsWith("1P") && isPartNumber(code.slice(2))) code = code.slice(2);
    if (!isPartNumber(code)) return { ok: false, error: `"${raw.trim()}" không giống Part No. của Apple (vd: MDEM1LL/A)` };
    return { ok: true, code, region: partNumberRegion(code) };
  }
  if (type === "UPC") return isValidUpcA(code) ? { ok: true, code, region: null } : { ok: false, error: "UPC phải đủ 12 số và đúng số kiểm tra" };
  return isValidEan13(code) ? { ok: true, code, region: null } : { ok: false, error: "EAN phải đủ 13 số và đúng số kiểm tra" };
}

// ---- Lược đồ form -----------------------------------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Tối đa ${max} ký tự`)
    .transform((s) => (s === "" ? null : s));
const required = (label: string, max = 120) => z.string().trim().min(1, `Nhập ${label}`).max(max, `Tối đa ${max} ký tự`);
const smallInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .transform((s, ctx) => {
      if (s === "") return null;
      if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) {
        ctx.addIssue({ code: "custom", message: `${label} phải là số nguyên từ ${min} đến ${max}` });
        return z.NEVER;
      }
      return Number(s);
    });
const decimal = (label: string, scale: number, { positive = false, optional = true } = {}) =>
  z.string().transform((s, ctx) => {
    if (s.trim() === "") {
      if (optional) return null;
      ctx.addIssue({ code: "custom", message: `Nhập ${label}` });
      return z.NEVER;
    }
    const v = parseDecimalInput(s, scale);
    if (v === null || (positive && !(Number(v) > 0))) {
      ctx.addIssue({ code: "custom", message: `${label} không hợp lệ${positive ? " (phải > 0)" : ""}, tối đa ${scale} chữ số thập phân` });
      return z.NEVER;
    }
    return v;
  });
const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === "1");

export const modelSchema = z.object({
  category: z.enum(CATEGORIES, { error: "Chọn dòng sản phẩm" }),
  name: required("tên mẫu máy"),
  releaseYear: smallInt("Năm ra mắt", 2007, 2100),
});

export const variantSchema = z.object({
  modelId: z.guid({ error: "Chọn mẫu máy" }),
  sku: text(40).transform((s) => (s ? s.toUpperCase().replace(/\s+/g, "-") : null)),
  storage: text(20),
  color: text(40),
  chip: text(40),
  memory: text(20),
  connectivity: text(40),
  defaultWeightKg: decimal("Cân nặng mặc định", 3, { positive: true }),
  isActive: checkbox,
});

export const variantCodeSchema = z.object({
  variantId: z.guid({ error: "Chọn cấu hình" }),
  codeType: z.enum(CODE_TYPES).default("PART_NUMBER"),
  code: required("mã", 40),
});

export const supplierSchema = z.object({
  name: required("tên nơi mua"),
  kind: z.enum(SUPPLIER_KINDS).default("RETAILER"),
  usState: text(2)
    .refine((s) => s === null || /^[A-Za-z]{2}$/.test(s), "Bang là 2 chữ cái (vd: OR, DE)")
    .transform((s) => s?.toUpperCase() ?? null),
  returnDays: smallInt("Số ngày đổi trả", 0, 365),
  note: text(500),
});

export const carrierSchema = z.object({
  name: required("tên đơn vị vận chuyển"),
  legTypes: z.array(z.enum(LEG_TYPES)).min(1, "Chọn ít nhất một chặng"),
  trackingUrlTemplate: text(300).refine(
    (s) => s === null || (/^https?:\/\/\S+$/i.test(s) && s.includes("{tracking}")),
    "Mẫu link phải bắt đầu bằng http(s):// và chứa {tracking} (vd: https://…/track?no={tracking})",
  ),
  defaultLeadDays: smallInt("Số ngày giao dự kiến", 0, 120),
  contact: text(200),
  note: text(500),
});

export const accountSchema = z.object({
  name: required("tên tài khoản"),
  currency: z.enum(["VND", "USD"]).default("VND"),
  kind: z.enum(ACCOUNT_KINDS, { error: "Chọn loại tài khoản" }),
  openingBalance: decimal("Số dư đầu kỳ", 2).transform((v) => v ?? "0.00"),
  isActive: checkbox,
});

export type ModelInput = z.output<typeof modelSchema>;
export type VariantInput = z.output<typeof variantSchema>;
export type VariantCodeInput = z.output<typeof variantCodeSchema>;
export type SupplierInput = z.output<typeof supplierSchema>;
export type CarrierInput = z.output<typeof carrierSchema>;
export type AccountInput = z.output<typeof accountSchema>;

export type FieldErrors = Record<string, string>;

/** Kết quả kiểm tra form: dữ liệu sạch hoặc lỗi theo từng ô (tiếng Việt). */
export function validate<S extends z.ZodType>(schema: S, data: unknown): { ok: true; data: z.output<S> } | { ok: false; errors: FieldErrors } {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  const errors: FieldErrors = {};
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? "_");
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Tên hiển thị của một cấu hình: "iPhone Pro Max · 256GB · Silver". */
export function variantLabel(
  modelName: string,
  v: { storage?: string | null; color?: string | null; chip?: string | null; memory?: string | null; connectivity?: string | null },
) {
  return [modelName, v.chip, v.memory, v.storage, v.color, v.connectivity].filter(Boolean).join(" · ");
}
