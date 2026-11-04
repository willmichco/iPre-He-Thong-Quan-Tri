/**
 * Chuyến hàng · Đơn mua · Máy — lược đồ form (zod) cho phía máy chủ. Phần thuần (nhãn, mã chuyến, lưới nhập máy)
 * nằm ở purchasing-core.ts và được tái xuất ở đây.
 */
import { z } from "zod";
import { parseDecimalInput, validate, type FieldErrors } from "./catalog";

export { validate, type FieldErrors };
export * from "./purchasing-core";

// ---- Form chuyến & đơn mua ----------------------------------------------------------------------------

// ô không bắt buộc: form không có ô đó (undefined) coi như để trống
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
const money = (label: string, scale: number, { required = false, positive = false } = {}) =>
  z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (s.trim() === "") {
        if (!required) return scale ? `0.${"0".repeat(scale)}` : "0";
        ctx.addIssue({ code: "custom", message: `Nhập ${label}` });
        return z.NEVER;
      }
      const v = parseDecimalInput(s, scale);
      if (v === null || v.startsWith("-") || (positive && !(Number(v) > 0))) {
        ctx.addIssue({ code: "custom", message: `${label} không hợp lệ${positive ? " (phải > 0)" : ""}` });
        return z.NEVER;
      }
      return v;
    });
const optId = z
  .string()
  .default("")
  .transform((s: string) => s.trim())
  .transform((s) => (s === "" ? null : s))
  .refine((s) => s === null || z.guid().safeParse(s).success, "Lựa chọn không hợp lệ");

/**
 * Tỷ giá VND/USD: "26.350" / "26,350" là 26.350 đồng (dấu hàng nghìn kiểu Việt Nam), không phải 26,35.
 * "26.350,5" / "26350.5" vẫn đọc phần lẻ bình thường. Tối đa 4 chữ số thập phân.
 */
export function parseFxRate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return parseDecimalInput(s.replace(/[.,]/g, ""), 4);
  return parseDecimalInput(s, 4);
}

const fxRate = (label: string, required: boolean) =>
  z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (s.trim() === "") {
        if (!required) return null;
        ctx.addIssue({ code: "custom", message: `Nhập ${label}` });
        return z.NEVER;
      }
      const v = parseFxRate(s);
      if (v === null || !(Number(v) > 0)) {
        ctx.addIssue({ code: "custom", message: `${label} không hợp lệ` });
        return z.NEVER;
      }
      return v;
    });

export const batchSchema = z.object({
  code: optText(30)
    .transform((s) => s?.toUpperCase() ?? null)
    .refine((s) => s === null || /^[A-Z0-9][A-Z0-9-]*$/.test(s), "Mã chuyến chỉ gồm chữ, số và dấu gạch (vd: CH-2026-012)"),
  name: optText(120),
  plannedFxRate: fxRate("Tỷ giá dự kiến", false),
  note: optText(1000),
});

export const purchaseOrderSchema = z.object({
  supplierId: z.guid({ error: "Chọn nơi mua" }),
  orderNumber: optText(60),
  orderedAt: z
    .string()
    .default("")
    .transform((s: string) => s.trim())
    .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Nhập ngày đặt")),
  currency: z.enum(["USD", "VND"]).default("USD"),
  subtotal: money("Subtotal", 2, { required: true }),
  salesTax: money("Sales tax", 2),
  sellerShipping: money("Phí ship người bán", 2),
  discount: money("Giảm giá", 2),
  fxRate: fxRate("Tỷ giá thực tế", true).transform((v) => v!),
  fxFeeVnd: money("Phí chuyển đổi ngoại tệ", 0),
  paymentAccountId: optId,
  paidAt: optDate("Ngày thanh toán"),
  returnDeadline: optDate("Hạn đổi trả"),
  note: optText(1000),
});

export type BatchInput = z.output<typeof batchSchema>;
export type PurchaseOrderInput = z.output<typeof purchaseOrderSchema>;
