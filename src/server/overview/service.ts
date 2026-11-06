/**
 * Số liệu trang Tổng quan (tài liệu 04 mục 6 "GET /reports/overview", tài liệu 05 mục 4.1).
 * Chỉ đọc; mọi tiền là bigint VND, mọi ngày theo giờ Việt Nam.
 */
import { trackingAlerts } from "@/domain/tracking";
import { trackingBoard } from "@/server/tracking/service";
import type { Sql, TransactionSql } from "postgres";
import {
  alertSettingsFrom,
  buildAlerts,
  capitalByStage,
  fillMonths,
  last12Months,
  stageForStatus,
  stockSummary,
  type AlertInput,
  type Period,
  type StageKey,
} from "@/domain/overview";
import { percentBp } from "@/domain/costing";

type Db = Sql | TransactionSql;

/**
 * Trạng thái "vật lý" của máy: máy khách đã cọc (RESERVED) vẫn đang nằm ở đâu đó trên đường về —
 * suy từ mốc đã có, để vốn theo chặng phản ánh đúng chỗ tiền đang nằm.
 */
const PHYSICAL_STATUS = `
  CASE WHEN i.status = 'RESERVED' THEN
    CASE WHEN ms.sg_received_at IS NOT NULL THEN 'RESERVED'
         WHEN ms.domestic_departed_at IS NOT NULL THEN 'DOMESTIC_IN_TRANSIT'
         WHEN ms.hn_arrived_at IS NOT NULL THEN 'AT_HN'
         WHEN ms.intl_departed_at IS NOT NULL THEN 'INTL_IN_TRANSIT'
         WHEN ms.us_warehouse_at IS NOT NULL THEN 'AT_US_WAREHOUSE'
         WHEN ms.seller_shipped_at IS NOT NULL THEN 'US_IN_TRANSIT'
         ELSE 'ORDERED' END
  ELSE i.status::text END`;

export interface PnlTotals {
  units: number;
  revenueVnd: bigint;
  cogsVnd: bigint;
  grossProfitVnd: bigint;
  sellingExpenseVnd: bigint;
  profitVnd: bigint;
  /** số máy lãi còn "Tạm tính" (chuyến chưa chốt chi phí / còn dự toán) */
  provisional: number;
  opexVnd: bigint;
  netProfitVnd: bigint;
  marginBp: number | null;
}

async function pnl(db: Db, from: string, to: string): Promise<PnlTotals> {
  const [s] = await db<{ units: number; revenue: string; cogs: string; gross: string; selling: string; profit: string; provisional: number }[]>`
    SELECT COUNT(*)::int AS units, COALESCE(SUM(net_revenue_vnd), 0)::text AS revenue, COALESCE(SUM(cogs_vnd), 0)::text AS cogs,
           COALESCE(SUM(gross_profit_vnd), 0)::text AS gross, COALESCE(SUM(selling_expense_vnd), 0)::text AS selling,
           COALESCE(SUM(profit_vnd), 0)::text AS profit, (COUNT(*) FILTER (WHERE NOT is_final))::int AS provisional
      FROM v_sale_item_profit
     WHERE (sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${from}::date AND (sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < ${to}::date`;
  const [o] = await db<{ opex: string }[]>`
    SELECT COALESCE(SUM(CASE WHEN ct.direction = 'OUT' THEN ct.amount_vnd ELSE -ct.amount_vnd END), 0)::text AS opex
      FROM cash_transactions ct JOIN cash_categories cc ON cc.code = ct.category_code AND cc.is_operating
     WHERE ct.deleted_at IS NULL
       AND (ct.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${from}::date AND (ct.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < ${to}::date`;
  const revenue = BigInt(s.revenue);
  const profit = BigInt(s.profit);
  const opex = BigInt(o.opex);
  return {
    units: s.units,
    revenueVnd: revenue,
    cogsVnd: BigInt(s.cogs),
    grossProfitVnd: BigInt(s.gross),
    sellingExpenseVnd: BigInt(s.selling),
    profitVnd: profit,
    provisional: s.provisional,
    opexVnd: opex,
    netProfitVnd: profit - opex,
    marginBp: percentBp(profit, revenue),
  };
}

export async function getOverview(db: Db, period: Period, today: string) {
  const botPromise = trackingBoard(db);
  const months = last12Months(today);
  const year = Number(today.slice(0, 4));

  const [capitalRows, current, previous, monthRows, categoryRows, stockRows, shipmentRows, returnRows, saleRows, depositRows, [yr], settingRows, batchRows] =
    await Promise.all([
      db<{ status: string; n: number; capital: string }[]>`
        SELECT ${db.unsafe(PHYSICAL_STATUS)} AS status, COUNT(*)::int AS n, COALESCE(SUM(lc.landed_cost_vnd), 0)::text AS capital
          FROM items i JOIN v_item_landed_cost lc ON lc.item_id = i.id LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
         WHERE i.deleted_at IS NULL
           AND i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT', 'IN_STOCK', 'RESERVED', 'WARRANTY')
         GROUP BY 1`,
      pnl(db, period.from, period.to),
      pnl(db, period.prevFrom, period.prevTo),
      db<{ month: string; revenue: string; profit: string; units: number }[]>`
        SELECT date_trunc('month', sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS month,
               SUM(net_revenue_vnd)::text AS revenue, SUM(profit_vnd)::text AS profit, COUNT(*)::int AS units
          FROM v_sale_item_profit
         WHERE (sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${months[0]}::date
         GROUP BY 1`,
      db<{ category: string; units: number; revenue: string; profit: string }[]>`
        SELECT category::text, COUNT(*)::int AS units, SUM(net_revenue_vnd)::text AS revenue, SUM(profit_vnd)::text AS profit
          FROM v_sale_item_profit
         WHERE (sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${period.from}::date AND (sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < ${period.to}::date
         GROUP BY 1 ORDER BY SUM(profit_vnd) DESC`,
      db<{ id: string; label: string; days: number | null; cost: string; status: string }[]>`
        SELECT i.id::text, m.name || COALESCE(' ' || v.storage, '') AS label, i.status::text,
               FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)::int AS days, lc.landed_cost_vnd::text AS cost
          FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
          JOIN v_item_landed_cost lc ON lc.item_id = i.id LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
         WHERE i.deleted_at IS NULL AND (i.status = 'IN_STOCK' OR i.status = 'RESERVED' AND ms.sg_received_at IS NOT NULL)
         ORDER BY ms.sg_received_at NULLS LAST`,
      db<{ id: string; label: string; status: string; eta: string | null; held: string | null }[]>`
        SELECT s.id::text, COALESCE(s.tracking_number, s.reference_code, 'không mã') AS label, s.status::text, s.eta::text,
               (SELECT MAX(e.occurred_at)::text FROM shipment_tracking_events e WHERE e.shipment_id = s.id AND e.description LIKE 'Bị giữ%') AS held
          FROM shipments s WHERE s.status IN ('IN_TRANSIT', 'HOLD') ORDER BY s.eta NULLS LAST`,
      db<{ id: string; batch_id: string; label: string; deadline: string; pending: number }[]>`
        SELECT po.id::text, po.batch_id::text, b.code || COALESCE(' · ' || sp.name, '') || COALESCE(' #' || po.order_number, '') AS label,
               po.return_deadline::text AS deadline,
               (SELECT COUNT(*)::int FROM items i WHERE i.purchase_order_id = po.id AND i.deleted_at IS NULL
                   AND i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT', 'DAMAGED')) AS pending
          FROM purchase_orders po JOIN batches b ON b.id = po.batch_id LEFT JOIN suppliers sp ON sp.id = po.supplier_id
         WHERE po.deleted_at IS NULL AND b.deleted_at IS NULL AND po.return_deadline IS NOT NULL
           AND po.return_deadline >= ${today}::date AND po.return_deadline <= ${today}::date + 31
         ORDER BY po.return_deadline`,
      // chỉ đơn còn nợ: gom tổng đơn & tiền đã nhận một lượt (hash), lọc ngay trong CSDL
      db<{ id: string; code: string; status: string; customer: string | null; total: string; paid: string }[]>`
        WITH tot AS (
          SELECT si.sale_id, SUM(si.price_vnd - si.discount_alloc_vnd) AS total
            FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.status IN ('COMPLETED', 'DEPOSITED')
           WHERE si.voided_at IS NULL GROUP BY si.sale_id
        ), paid AS (
          SELECT t.sale_id, SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END) AS paid
            FROM cash_transactions t JOIN sales s ON s.id = t.sale_id AND s.status IN ('COMPLETED', 'DEPOSITED')
           WHERE t.deleted_at IS NULL GROUP BY t.sale_id
        )
        SELECT s.id::text, s.code, s.status::text, c.full_name AS customer,
               COALESCE(tot.total, 0)::text AS total, COALESCE(paid.paid, 0)::text AS paid
          FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN tot ON tot.sale_id = s.id LEFT JOIN paid ON paid.sale_id = s.id
         WHERE s.status IN ('COMPLETED', 'DEPOSITED') AND COALESCE(tot.total, 0) - COALESCE(paid.paid, 0) > 0
         ORDER BY s.sold_at`,
      db<{ id: string; code: string; customer: string | null }[]>`
        SELECT s.id::text, s.code, c.full_name AS customer
          FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.status = 'DEPOSITED'
           AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM sale_items si LEFT JOIN v_item_milestones ms ON ms.item_id = si.item_id
                            WHERE si.sale_id = s.id AND si.voided_at IS NULL AND ms.sg_received_at IS NULL)
         ORDER BY s.sold_at`,
      db<{ revenue: string | null }[]>`SELECT revenue_vnd::text AS revenue FROM v_yearly_revenue WHERE year = ${year}`.then((r) =>
        r.length ? r : [{ revenue: null }],
      ),
      db<{ key: string; value: string }[]>`SELECT key, value::text FROM app_settings WHERE key LIKE 'alert.%' OR key LIKE 'tax.%'`,
      db<{ id: string; code: string; status: string; finalized: boolean; status_item: string; n: number; capital: string }[]>`
        SELECT b.id::text, b.code, b.status::text, b.costs_finalized_at IS NOT NULL AS finalized, ${db.unsafe(PHYSICAL_STATUS)} AS status_item,
               COUNT(i.id)::int AS n, COALESCE(SUM(lc.landed_cost_vnd), 0)::text AS capital
          FROM batches b
          JOIN items i ON i.batch_id = b.id AND i.deleted_at IS NULL
          JOIN v_item_landed_cost lc ON lc.item_id = i.id LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
         WHERE b.deleted_at IS NULL AND b.status IN ('PURCHASING', 'IN_TRANSIT', 'ARRIVED')
         GROUP BY b.id, b.code, b.status, b.costs_finalized_at, 5
         ORDER BY b.code`,
    ]);

  const capital = capitalByStage(capitalRows.map((r) => ({ status: r.status, itemCount: r.n, capitalVnd: BigInt(r.capital) })));
  const stockList = stockRows.map((r) => ({ id: r.id, label: r.label, days: r.days, costVnd: BigInt(r.cost), reserved: r.status === "RESERVED" }));
  const stock = stockSummary(stockList);
  const settings = alertSettingsFrom(settingRows);
  const yearRevenueVnd = BigInt(yr.revenue ?? "0");
  const receivables = saleRows.map((r) => ({ id: r.id, code: r.code, customer: r.customer, status: r.status, balanceVnd: BigInt(r.total) - BigInt(r.paid) }));

  const bot = await botPromise;
  const alertInput: AlertInput = {
    trackAlerts: trackingAlerts(bot.rows, new Date()),
    today,
    shipments: shipmentRows.map((r) => ({ id: r.id, label: r.label, status: r.status, eta: r.eta, heldSince: r.held })),
    stock: stockList,
    returnDeadlines: returnRows.map((r) => ({ poId: r.id, batchId: r.batch_id, label: r.label, deadline: r.deadline, pendingItems: r.pending })),
    receivables,
    depositsReady: depositRows,
    yearRevenueVnd,
    year,
  };

  // chuyến đang chạy: số máy theo chặng
  const batches = new Map<
    string,
    {
      id: string;
      code: string;
      status: string;
      finalized: boolean;
      itemCount: number;
      soldCount: number;
      capitalVnd: bigint;
      byStage: Partial<Record<StageKey, number>>;
    }
  >();
  for (const r of batchRows) {
    const b = batches.get(r.id) ?? {
      id: r.id,
      code: r.code,
      status: r.status,
      finalized: r.finalized,
      itemCount: 0,
      soldCount: 0,
      capitalVnd: 0n,
      byStage: {},
    };
    b.itemCount += r.n;
    b.capitalVnd += BigInt(r.capital);
    const st = stageForStatus(r.status_item);
    if (st) b.byStage[st] = (b.byStage[st] ?? 0) + r.n;
    else if (r.status_item === "SOLD") b.soldCount += r.n;
    batches.set(r.id, b);
  }

  return {
    period,
    capital,
    current,
    previous,
    months: fillMonths(
      months,
      monthRows.map((r) => ({ month: r.month, revenueVnd: BigInt(r.revenue), profitVnd: BigInt(r.profit), units: r.units })),
    ),
    categories: categoryRows.map((r) => ({ category: r.category, units: r.units, revenueVnd: BigInt(r.revenue), profitVnd: BigInt(r.profit) })),
    stock,
    alerts: buildAlerts(alertInput, settings),
    settings,
    yearRevenueVnd,
    taxBp: percentBp(yearRevenueVnd, settings.revenueThresholdVnd),
    receivableVnd: receivables.reduce((a, r) => a + (r.balanceVnd > 0n ? r.balanceVnd : 0n), 0n),
    activeBatches: [...batches.values()],
    bot,
  };
}
export type Overview = Awaited<ReturnType<typeof getOverview>>;

/** Máy đang nằm ở một chặng (theo trạng thái vật lý, máy đã cọc tính đúng chỗ nó đang nằm) — trang Kho máy lọc theo chặng. */
export async function listItemsAtStatuses(db: Db, statuses: readonly string[], limit = 200) {
  return db<
    { id: string; label: string; serial_number: string | null; imei1: string | null; status: string; batch_code: string; cost: string; days: number | null }[]
  >`
    SELECT * FROM (
      SELECT i.id::text, m.name || COALESCE(' · ' || v.storage, '') || COALESCE(' · ' || v.color, '') AS label, i.serial_number, i.imei1,
             i.status::text, ${db.unsafe(PHYSICAL_STATUS)} AS physical, b.code AS batch_code, lc.landed_cost_vnd::text AS cost,
             FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)::int AS days, ms.sg_received_at, ms.ordered_at, i.created_at
        FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
        JOIN batches b ON b.id = i.batch_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
        LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
       -- trạng thái vật lý ∈ statuses ⇒ trạng thái lưu ∈ statuses hoặc là RESERVED: lọc trước bằng chỉ mục
       WHERE i.deleted_at IS NULL AND (i.status::text = ANY(${statuses as string[]}) OR i.status = 'RESERVED')) x
     WHERE x.physical = ANY(${statuses as string[]})
     ORDER BY x.sg_received_at NULLS LAST, x.ordered_at NULLS LAST, x.created_at
     LIMIT ${limit}`;
}
