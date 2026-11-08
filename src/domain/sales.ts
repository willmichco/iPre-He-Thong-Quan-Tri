/**
 * Bán hàng — phần thuần (tài liệu 01 mục 6–8, tài liệu 05 mục 4.5): ô tiền gõ tắt, xem trước lãi, mã đơn bán,
 * hạn bảo hành, trạng thái máy khi huỷ cọc / khách trả lại.
 */
import { z } from "zod";
import { CHANNELS, parseVndInput } from "./sales-core";

export * from "./sales-core";

// ---- Mã đơn, bảo hành, trạng thái ---------------------------------------------------------------------

/** BH-2026-0001 → BH-2026-0002 (theo năm). */
export function nextSaleCode(year: number, existing: readonly string[]): string {
  const re = new RegExp(`^BH-${year}-(\\d+)$`);
  const max = existing.reduce((m, c) => Math.max(m, Number(re.exec(c)?.[1] ?? 0)), 0);
  return `BH-${year}-${String(max + 1).padStart(4, "0")}`;
}

/** Hạn bảo hành shop = ngày bán (giờ VN, YYYY-MM-DD) + số tháng; cuối tháng thì lùi về ngày cuối của tháng đích. */
export function warrantyUntil(soldDate: string, months: number): string | null {
  if (months <= 0) return null;
  const [y, m, d] = soldDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Trạng thái "đường về" của máy suy ra từ các mốc đã có — dùng khi huỷ cọc / khách trả lại. */
export function statusFromEvents(events: readonly string[]): string {
  const order: [string, string][] = [
    ["SG_RECEIVED", "IN_STOCK"],
    ["DOMESTIC_DEPARTED", "DOMESTIC_IN_TRANSIT"],
    ["HN_ARRIVED", "AT_HN"],
    ["INTL_DEPARTED", "INTL_IN_TRANSIT"],
    ["US_WAREHOUSE_RECEIVED", "AT_US_WAREHOUSE"],
    ["SELLER_SHIPPED", "US_IN_TRANSIT"],
  ];
  return order.find(([e]) => events.includes(e))?.[1] ?? "ORDERED";
}

// ---- Form bán nhanh -------------------------------------------------------------------------------------

const money = (label: string, required = false) =>
  z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (!s.trim()) {
        if (!required) return 0n;
        ctx.addIssue({ code: "custom", message: `Nhập ${label}` });
        return z.NEVER;
      }
      const v = parseVndInput(s);
      if (v === null) {
        ctx.addIssue({ code: "custom", message: `${label} không hợp lệ (vd 34,5tr · 30k · 34.500.000)` });
        return z.NEVER;
      }
      return v;
    });

export const saleSchema = z
  .object({
    lines: z
      .array(z.object({ itemId: z.guid(), price: money("Giá bán", true) }))
      .min(1, "Quét hoặc chọn ít nhất một máy")
      .max(20, "Tối đa 20 máy một đơn"),
    customerPhone: z
      .string()
      .default("")
      .transform((s) => s.replace(/[\s.-]/g, ""))
      .refine((s) => s === "" || /^(\+?84|0)\d{9,10}$/.test(s), "Số điện thoại không hợp lệ"),
    customerName: z
      .string()
      .default("")
      .transform((s) => s.trim())
      .pipe(z.string().max(120)),
    /** khách đã có (chọn từ danh sách / trợ lý tra ra) — ưu tiên hơn SĐT / tên */
    customerId: z
      .string()
      .default("")
      .transform((s) => s.trim() || null)
      .refine((s) => s === null || z.guid().safeParse(s).success, "Khách không hợp lệ"),
    channel: z.enum(CHANNELS).default("OTHER"),
    discount: money("Giảm giá"),
    shippingFee: money("Phí ship khách"),
    otherFee: money("Phí khác (COD, sàn…)"),
    payment: z.enum(["TRANSFER", "CASH", "DEPOSIT", "UNPAID"]).default("TRANSFER"),
    accountId: z
      .string()
      .default("")
      .transform((s) => s.trim() || null)
      .refine((s) => s === null || z.guid().safeParse(s).success, "Lựa chọn không hợp lệ"),
    paidAmount: money("Số tiền đã nhận"),
    warrantyMonths: z
      .string()
      .default("6")
      .transform((s, ctx) => {
        const n = Number(s.trim() || "0");
        if (!Number.isInteger(n) || n < 0 || n > 36) {
          ctx.addIssue({ code: "custom", message: "Bảo hành 0–36 tháng" });
          return z.NEVER;
        }
        return n;
      }),
    directShip: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true" || v === "1"),
    confirmBelowCost: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true" || v === "1"),
    einvoiceNo: z
      .string()
      .default("")
      .transform((s) => s.trim() || null),
    note: z
      .string()
      .default("")
      .transform((s) => s.trim() || null),
  })
  .superRefine((s, ctx) => {
    if (new Set(s.lines.map((l) => l.itemId)).size !== s.lines.length) ctx.addIssue({ code: "custom", path: ["lines"], message: "Một máy bị chọn 2 lần" });
    if (s.payment === "DEPOSIT" && s.paidAmount <= 0n) ctx.addIssue({ code: "custom", path: ["paidAmount"], message: "Nhập số tiền cọc" });
    if ((s.payment !== "UNPAID" || s.paidAmount > 0n) && !s.accountId)
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "Chọn tài khoản nhận tiền" });
    if (!s.customerPhone && !s.customerName && !s.customerId && s.payment === "DEPOSIT")
      ctx.addIssue({ code: "custom", path: ["customerPhone"], message: "Đơn cọc cần SĐT hoặc tên khách" });
  });
export type SaleInput = z.output<typeof saleSchema>;
