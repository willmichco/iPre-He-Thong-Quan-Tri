/**
 * Chi phí cấu thành giá vốn (nhóm B–E, tài liệu 01 mục 5) — phần thuần: loại chi phí, cách chia mặc định,
 * quy đổi VND theo tỷ giá riêng của từng khoản, đọc danh sách chia tay (MANUAL), lược đồ form.
 */
import { z } from "zod";
import { parseDecimalInput } from "./catalog";
import { toVnd, type AllocationMethod, type CostKind } from "./costing";
import { parseFxRate } from "./purchasing";

export const COST_KINDS: CostKind[] = [
  "US_DOMESTIC_SHIPPING",
  "INTL_SHIPPING",
  "INSURANCE",
  "CUSTOMS_TAX",
  "DOMESTIC_SHIPPING",
  "FX_FEE",
  "HANDLING",
  "OTHER_LANDED",
];

export const COST_KIND_LABEL: Record<CostKind, string> = {
  US_DOMESTIC_SHIPPING: "Ship nội địa Mỹ",
  INTL_SHIPPING: "Cước Mỹ → VN",
  INSURANCE: "Bảo hiểm / phụ thu",
  CUSTOMS_TAX: "Thuế, phí thông quan",
  DOMESTIC_SHIPPING: "Cước HN → SG",
  FX_FEE: "Phí chuyển tiền / ngoại tệ",
  HANDLING: "Kiểm máy, đóng gói, lưu kho",
  OTHER_LANDED: "Chi phí khác (vào giá vốn)",
};

export const METHODS: AllocationMethod[] = ["BY_QUANTITY", "BY_VALUE", "BY_WEIGHT", "MANUAL"];
export const METHOD_LABEL: Record<AllocationMethod, string> = {
  BY_QUANTITY: "Theo số lượng",
  BY_VALUE: "Theo giá trị",
  BY_WEIGHT: "Theo cân nặng",
  MANUAL: "Nhập tay từng máy",
};

/** Cách chia mặc định theo loại (tài liệu 01 mục 5.1): cước nội địa theo số lượng, cước quốc tế theo kg, bảo hiểm / thuế theo giá trị. */
export const DEFAULT_METHOD: Record<CostKind, AllocationMethod> = {
  US_DOMESTIC_SHIPPING: "BY_QUANTITY",
  INTL_SHIPPING: "BY_WEIGHT",
  INSURANCE: "BY_VALUE",
  CUSTOMS_TAX: "BY_VALUE",
  DOMESTIC_SHIPPING: "BY_QUANTITY",
  FX_FEE: "BY_VALUE",
  HANDLING: "BY_QUANTITY",
  OTHER_LANDED: "BY_VALUE",
};

/** Loại chi phí thường gặp của từng chặng (gợi ý đầu danh sách khi nhập chi phí cho kiện). */
export const KINDS_BY_LEG: Record<string, CostKind[]> = {
  US_DOMESTIC: ["US_DOMESTIC_SHIPPING"],
  US_TO_VN: ["INTL_SHIPPING", "INSURANCE", "CUSTOMS_TAX"],
  HN_TO_SG: ["DOMESTIC_SHIPPING", "INSURANCE"],
};

export const TARGET_TYPES = ["BATCH", "PURCHASE_ORDER", "SHIPMENT", "ITEM"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const TARGET_LABEL: Record<TargetType, string> = {
  BATCH: "Cả chuyến",
  PURCHASE_ORDER: "Đơn mua",
  SHIPMENT: "Kiện",
  ITEM: "Một máy",
};

const optText = (max: number) =>
  z
    .string()
    .default("")
    .transform((s: string) => s.trim())
    .pipe(z.string().max(max, `Tối đa ${max} ký tự`))
    .transform((s) => (s === "" ? null : s));
const optDate = (label: string) =>
  z
    .string()
    .default("")
    .transform((s: string) => s.trim())
    .refine((s) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s), `${label} không hợp lệ`)
    .transform((s) => (s === "" ? null : s));
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true" || v === "1");

/**
 * Form chi phí. `target` dạng "LOẠI:id" (vd "SHIPMENT:9000…") — một ô chọn duy nhất cho người dùng.
 * Số tiền âm = hoàn phí / điều chỉnh giảm. Chi phí bằng VND thì tỷ giá luôn là 1.
 */
export const costSchema = z
  .object({
    kind: z.enum(COST_KINDS as [CostKind, ...CostKind[]], { error: "Chọn loại chi phí" }),
    target: z
      .string()
      .default("")
      .transform((s, ctx) => {
        const m = /^(BATCH|PURCHASE_ORDER|SHIPMENT|ITEM):([0-9a-f-]{36})$/i.exec(s.trim());
        if (!m) {
          ctx.addIssue({ code: "custom", message: "Chọn chi phí này gắn vào đâu" });
          return z.NEVER;
        }
        return { type: m[1].toUpperCase() as TargetType, id: m[2].toLowerCase() };
      }),
    description: optText(200),
    currency: z.enum(["VND", "USD"]).default("VND"),
    amount: z
      .string()
      .default("")
      .transform((s, ctx) => {
        const v = parseDecimalInput(s, 2);
        if (s.trim() === "") ctx.addIssue({ code: "custom", message: "Nhập số tiền" });
        else if (v === null || Number(v) === 0) ctx.addIssue({ code: "custom", message: "Số tiền không hợp lệ (khác 0; âm = hoàn phí)" });
        else return v;
        return z.NEVER;
      }),
    fxRate: z.string().default(""),
    method: z.enum(METHODS as [AllocationMethod, ...AllocationMethod[]]).optional(),
    isEstimate: checkbox,
    hasValidInvoice: checkbox,
    incurredAt: z
      .string()
      .default("")
      .transform((s: string) => s.trim())
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Nhập ngày phát sinh")),
    accountId: z
      .string()
      .default("")
      .transform((s: string) => s.trim() || null)
      .refine((s) => s === null || z.guid().safeParse(s).success, "Lựa chọn không hợp lệ"),
    paidAt: optDate("Ngày trả"),
    manualShares: z.string().default(""),
    note: optText(1000),
  })
  .transform((c, ctx) => {
    let fx = "1.0000";
    if (c.currency === "USD") {
      const v = c.fxRate.trim() ? parseFxRate(c.fxRate) : null;
      if (v === null || !(Number(v) > 0)) {
        ctx.addIssue({ code: "custom", path: ["fxRate"], message: "Nhập tỷ giá của khoản này (vd 26.400)" });
        return z.NEVER;
      }
      fx = v;
    }
    const method = c.method ?? DEFAULT_METHOD[c.kind];
    return { ...c, fxRate: fx, method, amountVnd: toVnd(c.amount, fx) };
  });
export type CostFormInput = z.output<typeof costSchema>;

/**
 * Danh sách chia tay: mỗi dòng "mã máy (Serial/IMEI): số tiền VND", vd "F2LXQ7Y9KD: 250.000".
 * Trả lỗi theo dòng khi không đọc được.
 */
export function parseManualShares(text: string): { shares: { code: string; amountVnd: bigint }[]; errors: string[] } {
  const shares: { code: string; amountVnd: bigint }[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, k) => {
      const m = /^([A-Za-z0-9]+)\s*[:=\t ]\s*(-?[\d.,\s]+)\s*(?:đ|₫|vnd)?$/i.exec(line);
      const v = m ? parseDecimalInput(m[2].replace(/\s+/g, ""), 0) : null;
      if (!m || v === null) errors.push(`Dòng ${k + 1} "${line}": cần dạng "Serial hoặc IMEI: số tiền"`);
      else if (shares.some((s) => s.code === m[1].toUpperCase())) errors.push(`Dòng ${k + 1}: máy ${m[1].toUpperCase()} bị nhập 2 lần`);
      else shares.push({ code: m[1].toUpperCase(), amountVnd: BigInt(v) });
    });
  return { shares, errors };
}
