/**
 * Báo cáo — truy vấn số liệu. Mọi khoảng thời gian là [from, toExcl) theo giờ Việt Nam; so sánh trực tiếp trên cột
 * timestamptz (dùng được chỉ mục). Doanh thu / giá vốn / lãi lấy từ v_sale_item_profit (đơn hoàn tất, dòng còn hiệu lực).
 */
import type { Sql, TransactionSql } from "postgres";
import { median, monthsIn, type PnlNumbers } from "@/domain/reports";
import { listBatches } from "@/server/purchasing/service";

type Db = Sql | TransactionSql;

const ts = (d: string) => `${d}T00:00:00+07:00`;
const big = (s: string | null | undefined) => BigInt(s ?? "0");
const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

// ---- Lãi lỗ ---------------------------------------------------------------------------------------------

export interface PnlTotals extends PnlNumbers {
  provisional: number;
}

export async function pnlTotals(db: Db, from: string, toExcl: string): Promise<PnlTotals> {
  const [[s], [o]] = await Promise.all([
    db<{ units: number; revenue: string; cogs: string; selling: string; provisional: number }[]>`
      SELECT COUNT(*)::int AS units, COALESCE(SUM(net_revenue_vnd), 0)::text AS revenue, COALESCE(SUM(cogs_vnd), 0)::text AS cogs,
             COALESCE(SUM(selling_expense_vnd), 0)::text AS selling, (COUNT(*) FILTER (WHERE NOT is_final))::int AS provisional
        FROM v_sale_item_profit WHERE sold_at >= ${ts(from)} AND sold_at < ${ts(toExcl)}`,
    db<{ opex: string }[]>`
      SELECT COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.amount_vnd ELSE -t.amount_vnd END), 0)::text AS opex
        FROM cash_transactions t JOIN cash_categories c ON c.code = t.category_code AND c.is_operating
       WHERE t.deleted_at IS NULL AND t.occurred_at >= ${ts(from)} AND t.occurred_at < ${ts(toExcl)}`,
  ]);
  return {
    units: s.units,
    revenueVnd: big(s.revenue),
    cogsVnd: big(s.cogs),
    sellingExpenseVnd: big(s.selling),
    opexVnd: big(o.opex),
    provisional: s.provisional,
  };
}

/** Chi phí vận hành theo danh mục trong kỳ. */
export async function opexByCategory(db: Db, from: string, toExcl: string) {
  const rows = await db<{ code: string; name: string; v: string }[]>`
    SELECT c.code, c.name, SUM(CASE WHEN t.direction = 'OUT' THEN t.amount_vnd ELSE -t.amount_vnd END)::text AS v
      FROM cash_transactions t JOIN cash_categories c ON c.code = t.category_code AND c.is_operating
     WHERE t.deleted_at IS NULL AND t.occurred_at >= ${ts(from)} AND t.occurred_at < ${ts(toExcl)}
     GROUP BY c.code, c.name ORDER BY 3 DESC`;
  return rows.map((r) => ({ code: r.code, name: r.name, amountVnd: big(r.v) }));
}

export interface MonthRow {
  month: string;
  units: number;
  revenueVnd: bigint;
  cogsVnd: bigint;
  grossVnd: bigint;
  sellingVnd: bigint;
  opexVnd: bigint;
  netVnd: bigint;
}

/** Lãi lỗ từng tháng trong kỳ (đủ tháng, tháng trống = 0). */
export async function monthlyPnl(db: Db, from: string, toExcl: string): Promise<MonthRow[]> {
  const rows = await db<{ month: string; units: number; revenue: string; cogs: string; gross: string; selling: string; opex: string; net: string }[]>`
    SELECT month::text, units_sold::int AS units, revenue_vnd::text AS revenue, cogs_vnd::text AS cogs, gross_profit_vnd::text AS gross,
           selling_expense_vnd::text AS selling, opex_vnd::text AS opex, net_profit_before_tax_vnd::text AS net
      FROM v_monthly_pnl WHERE month >= date_trunc('month', ${from}::date) AND month < ${toExcl}::date`;
  const by = new Map(rows.map((r) => [r.month, r]));
  return monthsIn(from, toExcl).map((m) => {
    const r = by.get(m);
    return {
      month: m,
      units: r?.units ?? 0,
      revenueVnd: big(r?.revenue),
      cogsVnd: big(r?.cogs),
      grossVnd: big(r?.gross),
      sellingVnd: big(r?.selling),
      opexVnd: big(r?.opex),
      netVnd: big(r?.net),
    };
  });
}

// ---- Theo dòng máy --------------------------------------------------------------------------------------

export interface ModelRow {
  modelId: string;
  model: string;
  category: string;
  units: number;
  revenueVnd: bigint;
  cogsVnd: bigint;
  profitVnd: bigint;
  provisional: number;
  /** số ngày từ khi về SG tới khi bán (trung bình) */
  avgDaysToSell: number | null;
  inStock: number;
}

export async function byModel(db: Db, from: string, toExcl: string): Promise<{ rows: ModelRow[]; medianDays: number | null }> {
  const [sold, stock] = await Promise.all([
    db<{ id: string; name: string; category: string; units: number; revenue: string; cogs: string; profit: string; prov: number; days: string | null }[]>`
      SELECT pm.id::text, pm.name, pm.category::text, COUNT(*)::int AS units, SUM(p.net_revenue_vnd)::text AS revenue,
             SUM(p.cogs_vnd)::text AS cogs, SUM(p.profit_vnd)::text AS profit, (COUNT(*) FILTER (WHERE NOT p.is_final))::int AS prov,
             ROUND(AVG(EXTRACT(EPOCH FROM (p.sold_at - m.sg_received_at)) / 86400)
                   FILTER (WHERE m.sg_received_at IS NOT NULL AND p.sold_at >= m.sg_received_at), 1)::text AS days
        FROM v_sale_item_profit p JOIN items i ON i.id = p.item_id JOIN product_variants v ON v.id = i.variant_id
        JOIN product_models pm ON pm.id = v.model_id LEFT JOIN v_item_milestones m ON m.item_id = p.item_id
       WHERE p.sold_at >= ${ts(from)} AND p.sold_at < ${ts(toExcl)}
       GROUP BY pm.id, pm.name, pm.category ORDER BY SUM(p.profit_vnd) DESC, pm.name`,
    db<{ id: string; n: number }[]>`
      SELECT v.model_id::text AS id, COUNT(*)::int AS n FROM items i JOIN product_variants v ON v.id = i.variant_id
       WHERE i.deleted_at IS NULL AND i.status = 'IN_STOCK' GROUP BY v.model_id`,
  ]);
  const st = new Map(stock.map((s) => [s.id, s.n]));
  const rows = sold.map((r) => ({
    modelId: r.id,
    model: r.name,
    category: r.category,
    units: r.units,
    revenueVnd: big(r.revenue),
    cogsVnd: big(r.cogs),
    profitVnd: big(r.profit),
    provisional: r.prov,
    avgDaysToSell: num(r.days),
    inStock: st.get(r.id) ?? 0,
  }));
  return { rows, medianDays: median(rows.flatMap((r) => (r.avgDaysToSell === null ? [] : [r.avgDaysToSell]))) };
}

// ---- Theo chuyến ----------------------------------------------------------------------------------------

export interface BatchReportRow {
  id: string;
  code: string;
  name: string | null;
  status: string;
  itemCount: number;
  soldCount: number;
  totalLandedCostVnd: bigint;
  revenueVnd: bigint;
  realizedProfitVnd: bigint;
  unsoldCostVnd: bigint;
  roiBp: number | null;
  firstOrder: string | null;
  lastSale: string | null;
  /** chu kỳ vốn: ngày đặt đầu tiên → ngày bán cuối (chưa bán hết: tới hôm nay) */
  cycleDays: number | null;
  soldOut: boolean;
}

/** Tất cả chuyến (toàn thời gian), xếp theo ROI giảm dần. */
export async function byBatch(db: Db, today: string): Promise<BatchReportRow[]> {
  const [list, dates] = await Promise.all([
    listBatches(db),
    db<{ id: string; first_order: string | null; last_sale: string | null }[]>`
      SELECT b.id::text,
             (SELECT to_char(MIN(po.ordered_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') FROM purchase_orders po
               WHERE po.batch_id = b.id AND po.deleted_at IS NULL) AS first_order,
             (SELECT to_char(MAX(p.sold_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') FROM v_sale_item_profit p WHERE p.batch_id = b.id) AS last_sale
        FROM batches b WHERE b.deleted_at IS NULL`,
  ]);
  const d = new Map(dates.map((x) => [x.id, x]));
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  return list
    .map((b) => {
      const x = d.get(b.id);
      const soldOut = b.itemCount > 0 && b.soldCount === b.itemCount;
      const end = soldOut ? (x?.last_sale ?? today) : today;
      const roi = b.roiOnSoldPct === null ? null : Math.round(Number(b.roiOnSoldPct) * 100);
      return {
        id: b.id,
        code: b.code,
        name: b.name,
        status: b.status,
        itemCount: b.itemCount,
        soldCount: b.soldCount,
        totalLandedCostVnd: b.totalLandedCostVnd,
        revenueVnd: b.revenueVnd,
        realizedProfitVnd: b.realizedProfitVnd,
        unsoldCostVnd: b.unsoldCostVnd,
        roiBp: roi,
        firstOrder: x?.first_order ?? null,
        lastSale: x?.last_sale ?? null,
        cycleDays: x?.first_order ? Math.max(0, days(x.first_order, end)) : null,
        soldOut,
      };
    })
    .sort((a, b) => (b.roiBp ?? -1e9) - (a.roiBp ?? -1e9) || a.code.localeCompare(b.code));
}

// ---- Theo kênh bán --------------------------------------------------------------------------------------

export interface ChannelRow {
  channel: string;
  orders: number;
  units: number;
  revenueVnd: bigint;
  profitVnd: bigint;
}

export async function byChannel(db: Db, from: string, toExcl: string): Promise<ChannelRow[]> {
  const rows = await db<{ channel: string; orders: number; units: number; revenue: string; profit: string }[]>`
    SELECT channel, COUNT(DISTINCT sale_id)::int AS orders, COUNT(*)::int AS units,
           SUM(net_revenue_vnd)::text AS revenue, SUM(profit_vnd)::text AS profit
      FROM v_sale_item_profit WHERE sold_at >= ${ts(from)} AND sold_at < ${ts(toExcl)}
     GROUP BY channel ORDER BY SUM(net_revenue_vnd) DESC`;
  return rows.map((r) => ({ channel: r.channel, orders: r.orders, units: r.units, revenueVnd: big(r.revenue), profitVnd: big(r.profit) }));
}

// ---- Vận chuyển -----------------------------------------------------------------------------------------

export interface TransportRow {
  leg: string;
  carrier: string;
  shipments: number;
  items: number;
  arrived: number;
  avgDays: number | null;
  maxDays: number | null;
  late: number;
  hold: number;
}

/** Kiện gửi đi trong kỳ, theo chặng × đơn vị vận chuyển. Trễ = nhận sau ETA, hoặc chưa nhận mà đã quá ETA. */
export async function transport(db: Db, from: string, toExcl: string, today: string): Promise<TransportRow[]> {
  const rows = await db<
    { leg: string; carrier: string | null; n: number; items: number; arrived: number; avg: string | null; max: string | null; late: number; hold: number }[]
  >`
    SELECT s.leg_type::text AS leg, c.name AS carrier, COUNT(*)::int AS n,
           COALESCE(SUM((SELECT COUNT(*) FROM shipment_items si WHERE si.shipment_id = s.id)), 0)::int AS items,
           COUNT(s.arrived_at)::int AS arrived,
           ROUND(AVG(EXTRACT(EPOCH FROM (s.arrived_at - s.shipped_at)) / 86400), 1)::text AS avg,
           ROUND(MAX(EXTRACT(EPOCH FROM (s.arrived_at - s.shipped_at)) / 86400), 1)::text AS max,
           (COUNT(*) FILTER (WHERE s.eta IS NOT NULL AND (
              (s.arrived_at IS NOT NULL AND (s.arrived_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > s.eta)
              OR (s.arrived_at IS NULL AND s.eta < ${today}::date))))::int AS late,
           (COUNT(*) FILTER (WHERE s.status = 'HOLD'))::int AS hold
      FROM shipments s LEFT JOIN carriers c ON c.id = s.carrier_id
     WHERE s.shipped_at >= ${ts(from)} AND s.shipped_at < ${ts(toExcl)} AND s.status <> 'CANCELLED'
     GROUP BY s.leg_type, c.name ORDER BY s.leg_type, c.name NULLS LAST`;
  return rows.map((r) => ({
    leg: r.leg,
    carrier: r.carrier ?? "(chưa chọn)",
    shipments: r.n,
    items: r.items,
    arrived: r.arrived,
    avgDays: num(r.avg),
    maxDays: num(r.max),
    late: r.late,
    hold: r.hold,
  }));
}

// ---- Tồn kho --------------------------------------------------------------------------------------------

export interface AgingItem {
  itemId: string;
  label: string;
  serial: string | null;
  status: string;
  costVnd: bigint;
  targetPriceVnd: bigint | null;
  marketPriceVnd: bigint | null;
  days: number;
  bucket: string;
}

export const AGING_BUCKETS = ["0-15", "16-30", "31-60", ">60"] as const;

/** Tồn kho tại SG (kể cả máy khách cọc) theo tuổi tồn; danh sách cũ nhất trước. */
export async function inventory(db: Db) {
  const rows = await db<
    {
      item_id: string;
      model_name: string;
      storage: string | null;
      color: string | null;
      serial_number: string | null;
      status: string;
      cost: string;
      target: string | null;
      market: string | null;
      days: number;
      bucket: string;
    }[]
  >`
    SELECT item_id::text, model_name, storage, color, serial_number, status::text, landed_cost_vnd::text AS cost,
           target_price_vnd::text AS target, market_price_vnd::text AS market, days_in_stock AS days, aging_bucket AS bucket
      FROM v_inventory_aging ORDER BY days_in_stock DESC, model_name`;
  const items: AgingItem[] = rows.map((r) => ({
    itemId: r.item_id,
    label: [r.model_name, r.storage, r.color].filter(Boolean).join(" · "),
    serial: r.serial_number,
    status: r.status,
    costVnd: big(r.cost),
    targetPriceVnd: r.target === null ? null : big(r.target),
    marketPriceVnd: r.market === null ? null : big(r.market),
    days: r.days,
    bucket: r.bucket,
  }));
  const buckets = AGING_BUCKETS.map((b) => {
    const xs = items.filter((i) => i.bucket === b);
    return { bucket: b, count: xs.length, capitalVnd: xs.reduce((s, i) => s + i.costVnd, 0n) };
  });
  return { items, buckets, totalVnd: items.reduce((s, i) => s + i.costVnd, 0n) };
}

// ---- Doanh thu phục vụ kê khai thuế ---------------------------------------------------------------------

export interface TaxMonth {
  month: string;
  orders: number;
  units: number;
  revenueVnd: bigint;
  invoicedOrders: number;
  invoicedRevenueVnd: bigint;
}

export async function taxReport(db: Db, year: number) {
  const from = `${year}-01-01`;
  const toExcl = `${year + 1}-01-01`;
  const [months, uninvoiced, costs, opex, settings] = await Promise.all([
    db<{ month: string; orders: number; units: number; revenue: string; inv_orders: number; inv_revenue: string }[]>`
      SELECT date_trunc('month', s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS month,
             COUNT(DISTINCT s.id)::int AS orders, COUNT(*)::int AS units, SUM(si.price_vnd - si.discount_alloc_vnd)::text AS revenue,
             COUNT(DISTINCT s.id) FILTER (WHERE s.einvoice_no IS NOT NULL AND s.einvoice_no <> '')::int AS inv_orders,
             COALESCE(SUM(si.price_vnd - si.discount_alloc_vnd) FILTER (WHERE s.einvoice_no IS NOT NULL AND s.einvoice_no <> ''), 0)::text AS inv_revenue
        FROM sales s JOIN sale_items si ON si.sale_id = s.id AND si.voided_at IS NULL
       WHERE s.status = 'COMPLETED' AND s.sold_at >= ${ts(from)} AND s.sold_at < ${ts(toExcl)}
       GROUP BY 1`,
    db<{ id: string; code: string; date: string; customer: string | null; revenue: string }[]>`
      SELECT s.id::text, s.code, to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS date, c.full_name AS customer,
             SUM(si.price_vnd - si.discount_alloc_vnd)::text AS revenue
        FROM sales s JOIN sale_items si ON si.sale_id = s.id AND si.voided_at IS NULL LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'COMPLETED' AND (s.einvoice_no IS NULL OR s.einvoice_no = '')
         AND s.sold_at >= ${ts(from)} AND s.sold_at < ${ts(toExcl)}
       GROUP BY s.id, s.code, s.sold_at, c.full_name ORDER BY s.sold_at`,
    db<{ total: string; valid: string }[]>`
      SELECT COALESCE(SUM(amount_vnd), 0)::text AS total, COALESCE(SUM(amount_vnd) FILTER (WHERE has_valid_invoice), 0)::text AS valid
        FROM costs WHERE deleted_at IS NULL AND incurred_at >= ${from}::date AND incurred_at < ${toExcl}::date`,
    db<{ v: string }[]>`
      SELECT COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.amount_vnd ELSE -t.amount_vnd END), 0)::text AS v
        FROM cash_transactions t JOIN cash_categories c ON c.code = t.category_code AND c.is_operating
       WHERE t.deleted_at IS NULL AND t.occurred_at >= ${ts(from)} AND t.occurred_at < ${ts(toExcl)}`,
    db<{ key: string; value: unknown }[]>`SELECT key, value FROM app_settings WHERE key IN ('tax.revenue_threshold_vnd', 'tax.threshold_warning_ratio')`,
  ]);
  const by = new Map(months.map((m) => [m.month, m]));
  const rows: TaxMonth[] = monthsIn(from, toExcl).map((m) => {
    const r = by.get(m);
    return {
      month: m,
      orders: r?.orders ?? 0,
      units: r?.units ?? 0,
      revenueVnd: big(r?.revenue),
      invoicedOrders: r?.inv_orders ?? 0,
      invoicedRevenueVnd: big(r?.inv_revenue),
    };
  });
  const setting = (k: string, d: number) => {
    const v = settings.find((s) => s.key === k)?.value;
    return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;
  };
  return {
    year,
    months: rows,
    totalVnd: rows.reduce((s, r) => s + r.revenueVnd, 0n),
    invoicedVnd: rows.reduce((s, r) => s + r.invoicedRevenueVnd, 0n),
    uninvoiced: uninvoiced.map((u) => ({ id: u.id, code: u.code, date: u.date, customer: u.customer, revenueVnd: big(u.revenue) })),
    landedCostsVnd: big(costs[0].total),
    landedCostsValidVnd: big(costs[0].valid),
    opexVnd: big(opex[0].v),
    thresholdVnd: BigInt(Math.round(setting("tax.revenue_threshold_vnd", 1_000_000_000))),
    warnRatio: setting("tax.threshold_warning_ratio", 0.8),
  };
}
