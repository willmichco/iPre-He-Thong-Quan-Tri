/**
 * Bán hàng — phần thuần (tài liệu 01 mục 6–8, tài liệu 05 mục 4.5): ô tiền gõ tắt, xem trước lãi, mã đơn bán,
 * hạn bảo hành, trạng thái máy khi huỷ cọc / khách trả lại.
 */
import { z } from "zod";
import { computeSaleLines, itemProfit, percentBp, type ItemProfit } from "./costing";

export const CHANNELS = ["FACEBOOK", "ZALO", "TIKTOK", "SHOPEE", "WALK_IN", "REFERRAL", "OTHER"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = {
  FACEBOOK: "Facebook",
  ZALO: "Zalo",
  TIKTOK: "TikTok",
  SHOPEE: "Shopee",
  WALK_IN: "Tại shop",
  REFERRAL: "Giới thiệu",
  OTHER: "Khác",
};
export const SALE_STATUS_LABEL: Record<string, string> = { DEPOSITED: "Đã cọc", COMPLETED: "Hoàn tất", CANCELLED: "Đã huỷ" };

/** Trạng thái máy bán được ngay (hoàn tất); máy đang về thì chỉ nhận cọc (đặt trước), trừ khi bán giao thẳng. */
export const SELLABLE_NOW = ["IN_STOCK", "RESERVED"] as const;
/** Trạng thái không bán được (tài liệu 04 mục 4.2). */
export const NOT_SELLABLE = ["SOLD", "LOST", "DAMAGED", "RETURNED_TO_SELLER", "PERSONAL_USE", "WARRANTY"] as const;

// ---- Ô tiền gõ tắt --------------------------------------------------------------------------------------

/**
 * Tiền VND gõ tắt: "34,5tr" → 34.500.000 · "30k" → 30.000 · "1,2ty" / "1.2 tỷ" → 1.200.000.000 ·
 * "34.500.000" / "34500000" / "34,500,000" → 34.500.000. Không hiểu → null. Không nhận số âm.
 */
export function parseVndInput(raw: string): bigint | null {
  const s = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, "")
    .replace(/(vnd|d)$/, "");
  if (!s) return null;
  const m = /^(\d+(?:[.,]\d+)?)(k|nghin|ng|tr|trieu|cu|m|ty|b)$/.exec(s);
  if (m) {
    const unit = { k: 3, nghin: 3, ng: 3, tr: 6, trieu: 6, cu: 6, m: 6, ty: 9, b: 9 }[m[2] as "k"]!;
    const [int, frac = ""] = m[1].split(/[.,]/);
    if (frac.length > unit) return null;
    return BigInt(int + frac.padEnd(unit, "0"));
  }
  // số thường: dấu . hoặc , là phân cách hàng nghìn (tiền VND không có phần lẻ)
  if (/^\d{1,3}([.,]\d{3})+$/.test(s) || /^\d+$/.test(s)) return BigInt(s.replace(/[.,]/g, ""));
  return null;
}

// ---- Xem trước lãi --------------------------------------------------------------------------------------

export interface PreviewLine {
  itemId: string;
  priceVnd: bigint;
  costVnd: bigint;
}
export interface SalePreview {
  lines: (ItemProfit & { itemId: string; priceVnd: bigint; discountAllocVnd: bigint })[];
  revenueVnd: bigint;
  costVnd: bigint;
  expenseVnd: bigint;
  profitVnd: bigint;
  marginBp: number | null;
  /** máy bán dưới giá vốn (lãi gộp âm) → cần xác nhận lần hai */
  belowCost: string[];
}

/** Lãi của đơn bán trước khi chốt: giảm giá & chi phí bán hàng chia theo giá bán từng máy. */
export function previewSale(lines: readonly PreviewLine[], discountVnd = 0n, expensesVnd: readonly bigint[] = []): SalePreview {
  const sl = computeSaleLines({ discountVnd, expensesVnd: [...expensesVnd], lines: lines.map((l) => ({ itemId: l.itemId, priceVnd: l.priceVnd })) });
  const out = sl.map((l, k) => ({ ...itemProfit(l, lines[k].costVnd), itemId: l.itemId, priceVnd: l.priceVnd, discountAllocVnd: l.discountAllocVnd }));
  const sum = (f: (x: (typeof out)[number]) => bigint) => out.reduce((a, x) => a + f(x), 0n);
  const revenue = sum((x) => x.netRevenueVnd);
  const profit = sum((x) => x.profitVnd);
  return {
    lines: out,
    revenueVnd: revenue,
    costVnd: sum((x) => x.costVnd),
    expenseVnd: sum((x) => x.expenseAllocVnd),
    profitVnd: profit,
    marginBp: percentBp(profit, revenue),
    belowCost: out.filter((x) => x.grossProfitVnd < 0n).map((x) => x.itemId),
  };
}

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
    if (!s.customerPhone && !s.customerName && s.payment === "DEPOSIT")
      ctx.addIssue({ code: "custom", path: ["customerPhone"], message: "Đơn cọc cần SĐT hoặc tên khách" });
  });
export type SaleInput = z.output<typeof saleSchema>;
