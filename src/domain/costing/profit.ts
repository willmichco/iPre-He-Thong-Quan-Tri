/**
 * Lãi lỗ — tài liệu 01 mục 6–7. Lãi CHỈ được ghi nhận khi máy được bán; máy chưa bán chỉ có vốn đọng.
 *
 *   Doanh thu thuần (máy) = Giá bán − phân bổ giảm giá của đơn bán
 *   Lãi gộp (máy)         = Doanh thu thuần − Giá vốn về tay
 *   Lãi máy               = Lãi gộp − phân bổ chi phí bán hàng (ship khách, COD, phí sàn…)
 *   Biên lãi %            = Lãi máy ÷ Doanh thu thuần
 *   Lãi chuyến            = Σ Lãi máy đã bán     ROI = Lãi chuyến ÷ Σ Giá vốn máy đã bán
 *   Vốn còn đọng          = Σ Giá vốn máy chưa bán
 */
import { allocate } from "./allocation";
import { percentBp, type Vnd } from "./money";

export interface SaleLineInput {
  itemId: string;
  priceVnd: Vnd;
}

export interface SaleInput {
  /** giảm giá trên tổng đơn (sales.discount_vnd) */
  discountVnd?: Vnd;
  /** các khoản chi phí bán hàng của đơn (sale_expenses.amount_vnd) */
  expensesVnd?: Vnd[];
  lines: SaleLineInput[];
}

export interface SaleLine {
  itemId: string;
  priceVnd: Vnd;
  /** sale_items.discount_alloc_vnd */
  discountAllocVnd: Vnd;
  /** sale_items.expense_alloc_vnd */
  expenseAllocVnd: Vnd;
  netRevenueVnd: Vnd;
}

/** Phân bổ giảm giá và chi phí bán hàng của một đơn bán cho từng máy theo giá bán (đơn toàn 0 đồng → theo số lượng). */
export function computeSaleLines(sale: SaleInput): SaleLine[] {
  if (!sale.lines.length) return [];
  const prices = sale.lines.map((l) => l.priceVnd);
  const weights = prices.some((p) => p > 0n) ? prices : prices.map(() => 1n);
  const discount = allocate(sale.discountVnd ?? 0n, weights);
  const expenses = allocate(
    (sale.expensesVnd ?? []).reduce((a, b) => a + b, 0n),
    weights,
  );
  return sale.lines.map((l, k) => ({
    itemId: l.itemId,
    priceVnd: l.priceVnd,
    discountAllocVnd: discount[k],
    expenseAllocVnd: expenses[k],
    netRevenueVnd: l.priceVnd - discount[k],
  }));
}

export interface ItemProfit {
  netRevenueVnd: Vnd;
  costVnd: Vnd;
  grossProfitVnd: Vnd;
  expenseAllocVnd: Vnd;
  profitVnd: Vnd;
  /** biên lãi, đơn vị 0,01% (553 = 5,53%); null khi doanh thu thuần ≤ 0 */
  marginBp: number | null;
}

export function itemProfit(line: Pick<SaleLine, "netRevenueVnd" | "expenseAllocVnd">, costVnd: Vnd): ItemProfit {
  const gross = line.netRevenueVnd - costVnd;
  const profit = gross - line.expenseAllocVnd;
  return {
    netRevenueVnd: line.netRevenueVnd,
    costVnd,
    grossProfitVnd: gross,
    expenseAllocVnd: line.expenseAllocVnd,
    profitVnd: profit,
    marginBp: percentBp(profit, line.netRevenueVnd),
  };
}

export interface BatchItemState {
  itemId: string;
  /** giá vốn về tay hiện tại */
  costVnd: Vnd;
  /** có = đã bán (dòng bán còn hiệu lực) */
  sale?: Pick<SaleLine, "netRevenueVnd" | "expenseAllocVnd">;
  /** máy không còn để bán (thất lạc, hỏng, dùng cá nhân…) — không tính vào vốn đọng */
  writtenOff?: boolean;
}

export interface BatchSummary {
  itemCount: number;
  soldCount: number;
  unsoldCount: number;
  totalLandedCostVnd: Vnd;
  soldCostVnd: Vnd;
  revenueVnd: Vnd;
  /** lãi chuyến đã thực hiện = Σ lãi máy đã bán */
  realizedProfitVnd: Vnd;
  /** ROI trên vốn đã bán, đơn vị 0,01% */
  roiOnSoldBp: number | null;
  /** vốn còn đọng = Σ giá vốn máy chưa bán (trừ máy đã loại bỏ) */
  tiedCapitalVnd: Vnd;
  writtenOffCostVnd: Vnd;
}

export function batchSummary(items: readonly BatchItemState[]): BatchSummary {
  let total = 0n,
    soldCost = 0n,
    revenue = 0n,
    profit = 0n,
    tied = 0n,
    writtenOff = 0n,
    sold = 0;
  for (const it of items) {
    total += it.costVnd;
    if (it.sale) {
      sold++;
      soldCost += it.costVnd;
      revenue += it.sale.netRevenueVnd;
      profit += itemProfit(it.sale, it.costVnd).profitVnd;
    } else if (it.writtenOff) writtenOff += it.costVnd;
    else tied += it.costVnd;
  }
  return {
    itemCount: items.length,
    soldCount: sold,
    unsoldCount: items.length - sold,
    totalLandedCostVnd: total,
    soldCostVnd: soldCost,
    revenueVnd: revenue,
    realizedProfitVnd: profit,
    roiOnSoldBp: percentBp(profit, soldCost),
    tiedCapitalVnd: tied,
    writtenOffCostVnd: writtenOff,
  };
}

/** 553 → "5,53%" */
export function formatBp(bp: number | null): string {
  if (bp === null) return "—";
  const neg = bp < 0;
  const a = Math.abs(bp);
  return `${neg ? "−" : ""}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}%`;
}
