/**
 * Bán hàng — phần thuần dùng được ở trình duyệt (không kéo theo zod): kênh bán, ô tiền gõ tắt, xem trước lãi.
 * sales.ts tái xuất toàn bộ, nên phía máy chủ vẫn nhập từ "@/domain/sales" như cũ.
 */
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
