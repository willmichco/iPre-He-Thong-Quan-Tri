/**
 * Trợ lý — các truy vấn nhỏ mà trang có sẵn chưa cần: tồn theo cấu hình, chọn máy tồn lâu nhất (FIFO), đơn bán theo kỳ,
 * tra mã đơn / chuyến / vận đơn, đơn mua gần đây, đơn còn nợ / đang cọc của một khách.
 */
import type { Sql, TransactionSql } from "postgres";
import { variantLabel } from "@/domain/catalog";

type Db = Sql | TransactionSql;
const ts = (d: string) => `${d}T00:00:00+07:00`;

export interface VariantStock {
  variantId: string;
  label: string;
  inStock: number;
  reserved: number;
  incoming: number;
  costVnd: bigint;
  oldestDays: number | null;
}

/** Số máy theo cấu hình: tồn SG (sẵn bán), khách cọc, đang về. `variantIds` trống = mọi cấu hình có máy. */
export async function stockByVariant(db: Db, variantIds: readonly string[] = []): Promise<VariantStock[]> {
  const rows = await db<
    {
      id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      in_stock: number;
      reserved: number;
      incoming: number;
      cost: string;
      oldest: number | null;
    }[]
  >`
    SELECT v.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity,
           COUNT(*) FILTER (WHERE i.status = 'IN_STOCK')::int AS in_stock,
           COUNT(*) FILTER (WHERE i.status = 'RESERVED')::int AS reserved,
           COUNT(*) FILTER (WHERE i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT'))::int AS incoming,
           COALESCE(SUM(lc.landed_cost_vnd) FILTER (WHERE i.status = 'IN_STOCK'), 0)::text AS cost,
           MAX(FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)) FILTER (WHERE i.status = 'IN_STOCK')::int AS oldest
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN v_item_landed_cost lc ON lc.item_id = i.id LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
     WHERE i.deleted_at IS NULL
       AND i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT', 'IN_STOCK', 'RESERVED')
       ${variantIds.length ? db`AND v.id = ANY(${[...variantIds]}::uuid[])` : db``}
     GROUP BY v.id, m.name, m.category, v.storage, v.color, v.chip, v.memory, v.connectivity
     ORDER BY m.category, m.name, v.storage, v.color`;
  return rows.map((r) => ({
    variantId: r.id,
    label: variantLabel(r.model, r),
    inStock: r.in_stock,
    reserved: r.reserved,
    incoming: r.incoming,
    costVnd: BigInt(r.cost),
    oldestDays: r.oldest,
  }));
}

/** Máy còn bán được của một cấu hình, tồn lâu nhất trước (chưa về SG xếp sau — chỉ cọc được). */
export async function sellableOfVariant(db: Db, variantId: string, limit = 20) {
  return db<{ id: string; serial_number: string | null; imei1: string | null; days: number | null; arrived: boolean }[]>`
    SELECT i.id::text, i.serial_number, i.imei1, FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)::int AS days,
           ms.sg_received_at IS NOT NULL AS arrived
      FROM items i LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
     WHERE i.deleted_at IS NULL AND i.variant_id = ${variantId}
       AND i.status IN ('IN_STOCK', 'ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT')
       AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                        WHERE si.item_id = i.id AND si.voided_at IS NULL AND s.status <> 'CANCELLED')
     ORDER BY ms.sg_received_at NULLS LAST, ms.ordered_at NULLS LAST, i.created_at
     LIMIT ${limit}`;
}

export interface SaleBrief {
  id: string;
  code: string;
  status: string;
  soldAt: string;
  customer: string | null;
  customerId: string | null;
  items: string;
  revenueVnd: bigint;
  profitVnd: bigint | null;
  balanceVnd: bigint;
}

const SALE_BRIEF = (db: Db) => db`
  SELECT s.id::text, s.code, s.status::text, to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS sold_at,
         c.full_name AS customer, c.id::text AS customer_id,
         (SELECT string_agg(m.name || COALESCE(' ' || v.storage, ''), ', ' ORDER BY si.id) FROM sale_items si
            JOIN items i ON i.id = si.item_id JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
           WHERE si.sale_id = s.id AND si.voided_at IS NULL) AS items,
         (SELECT COALESCE(SUM(si.price_vnd - si.discount_alloc_vnd), 0)::text FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL) AS revenue,
         (SELECT SUM(p.profit_vnd)::text FROM v_sale_item_profit p WHERE p.sale_id = s.id) AS profit,
         (SELECT COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END), 0)::text
            FROM cash_transactions t WHERE t.sale_id = s.id AND t.deleted_at IS NULL) AS paid
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;

type RawBrief = {
  id: string;
  code: string;
  status: string;
  sold_at: string;
  customer: string | null;
  customer_id: string | null;
  items: string | null;
  revenue: string;
  profit: string | null;
  paid: string;
};
const brief = (r: RawBrief): SaleBrief => ({
  id: r.id,
  code: r.code,
  status: r.status,
  soldAt: r.sold_at,
  customer: r.customer,
  customerId: r.customer_id,
  items: r.items ?? "",
  revenueVnd: BigInt(r.revenue),
  profitVnd: r.profit === null ? null : BigInt(r.profit),
  balanceVnd: r.status === "CANCELLED" ? 0n : BigInt(r.revenue) - BigInt(r.paid),
});

/** Đơn bán trong kỳ [from, toExcl) theo giờ VN, mới trước. */
export async function listSalesBetween(db: Db, from: string, toExcl: string, limit = 200): Promise<SaleBrief[]> {
  const rows = await db<RawBrief[]>`${SALE_BRIEF(db)} WHERE s.sold_at >= ${ts(from)} AND s.sold_at < ${ts(toExcl)} AND s.status <> 'CANCELLED'
    ORDER BY s.sold_at DESC, s.code DESC LIMIT ${limit}`;
  return rows.map(brief);
}

export async function findSaleByCode(db: Db, code: string): Promise<SaleBrief | null> {
  const [r] = await db<RawBrief[]>`${SALE_BRIEF(db)} WHERE s.code = ${code.toUpperCase()}`;
  return r ? brief(r) : null;
}

/** Đơn còn nợ / đang cọc của một khách (để "chị Lan trả thêm 3tr", "hoàn tất đơn chị Lan"). */
export async function openSalesOfCustomer(db: Db, customerId: string, onlyDeposited = false): Promise<SaleBrief[]> {
  const rows = await db<RawBrief[]>`${SALE_BRIEF(db)} WHERE s.customer_id = ${customerId}
      AND ${onlyDeposited ? db`s.status = 'DEPOSITED'` : db`s.status IN ('DEPOSITED', 'COMPLETED')`}
    ORDER BY s.sold_at DESC LIMIT 20`;
  return rows.map(brief).filter((s) => onlyDeposited || s.balanceVnd > 0n);
}

export async function findBatchByCode(db: Db, code: string): Promise<{ id: string; code: string } | null> {
  const [b] = await db<{ id: string; code: string }[]>`SELECT id::text, code FROM batches WHERE code = ${code.toUpperCase()} AND deleted_at IS NULL`;
  return b ?? null;
}

export interface ShipmentBrief {
  id: string;
  label: string;
  legType: string;
  status: string;
  itemCount: number;
}
export async function findShipmentByCode(db: Db, code: string): Promise<ShipmentBrief | null> {
  const c = code.replace(/[\s-]+/g, "").toUpperCase();
  const [s] = await db<{ id: string; label: string; leg: string; status: string; n: number }[]>`
    SELECT sh.id::text, COALESCE(sh.tracking_number, sh.reference_code) AS label, sh.leg_type::text AS leg, sh.status::text,
           (SELECT COUNT(*)::int FROM shipment_items si WHERE si.shipment_id = sh.id) AS n
      FROM shipments sh
     WHERE upper(replace(COALESCE(sh.tracking_number, ''), ' ', '')) = ${c} OR upper(COALESCE(sh.reference_code, '')) = ${c}
     ORDER BY sh.created_at DESC LIMIT 1`;
  return s ? { id: s.id, label: s.label, legType: s.leg, status: s.status, itemCount: s.n } : null;
}

export interface PoBrief {
  id: string;
  batchId: string;
  batchCode: string;
  label: string;
  currency: string;
  fxRate: string;
  orderedAt: string;
}
/** Đơn mua của một chuyến (hoặc các chuyến đang mở gần nhất). */
export async function purchaseOrdersFor(db: Db, batchCode?: string): Promise<PoBrief[]> {
  const rows = await db<{ id: string; batch_id: string; batch_code: string; label: string; currency: string; fx: string; ordered: string }[]>`
    SELECT po.id::text, b.id::text AS batch_id, b.code AS batch_code, s.name || COALESCE(' · ' || po.order_number, '') AS label,
           po.currency::text AS currency, po.fx_rate::text AS fx, to_char(po.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ordered
      FROM purchase_orders po JOIN batches b ON b.id = po.batch_id JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.deleted_at IS NULL AND b.deleted_at IS NULL
       ${batchCode ? db`AND b.code = ${batchCode.toUpperCase()}` : db`AND b.status NOT IN ('COSTS_FINALIZED', 'CLOSED')`}
     ORDER BY po.ordered_at DESC LIMIT 8`;
  return rows.map((r) => ({ id: r.id, batchId: r.batch_id, batchCode: r.batch_code, label: r.label, currency: r.currency, fxRate: r.fx, orderedAt: r.ordered }));
}

/** Máy theo vài ký tự cuối / một phần Serial-IMEI. */
export async function itemsByPartialCode(db: Db, part: string, limit = 8) {
  const c = part.trim().toUpperCase();
  return db<{ id: string; serial_number: string | null; imei1: string | null; status: string; label: string }[]>`
    SELECT i.id::text, i.serial_number, i.imei1, i.status::text, m.name || COALESCE(' · ' || v.storage, '') || COALESCE(' · ' || v.color, '') AS label
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
     WHERE i.deleted_at IS NULL AND (i.serial_number LIKE ${`%${c}`} OR i.imei1 LIKE ${`%${c}`} OR i.imei2 LIKE ${`%${c}`}
           OR i.serial_number LIKE ${`%${c}%`} OR i.imei1 LIKE ${`%${c}%`})
     ORDER BY (i.status IN ('IN_STOCK', 'RESERVED')) DESC, i.created_at DESC
     LIMIT ${limit}`;
}

/** Ngày về SG và ngày đặt của các máy (chặn ghi lùi ngày bán trước khi máy về). */
export async function itemDates(db: Db, ids: readonly string[]) {
  return db<{ id: string; sg: string | null; ordered: string | null }[]>`
    SELECT item_id::text AS id, to_char(sg_received_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS sg,
           to_char(ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ordered
      FROM v_item_milestones WHERE item_id = ANY(${[...ids]}::uuid[])`;
}
