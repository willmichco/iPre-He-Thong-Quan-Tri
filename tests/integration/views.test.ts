/**
 * Các truy vấn được viết lại để chạy nhanh (migration 0004, listBatches) phải cho ĐÚNG cùng số liệu với cách tính gốc.
 * So từng máy / từng chuyến trên toàn bộ dữ liệu đang có (dữ liệu ví dụ + mọi thứ kiểm thử khác để lại).
 */
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { listBatches } from "@/server/purchasing/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

describe("View tính theo từng máy ↔ cách tính gốc (gom cả bảng)", () => {
  it("v_item_landed_cost: từng máy, từng nhóm thành phần giá vốn", async () => {
    const diff = await sql`
      WITH ref AS (
        SELECT i.id AS item_id, i.batch_id,
          COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN ('PRICE','SALES_TAX','SELLER_SHIPPING','DISCOUNT','PO_FX_FEE')), 0)::bigint AS purchase_vnd,
          COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'US_DOMESTIC_SHIPPING'), 0)::bigint AS us_domestic_vnd,
          COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN ('INTL_SHIPPING','INSURANCE','CUSTOMS_TAX')), 0)::bigint AS international_vnd,
          COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'DOMESTIC_SHIPPING'), 0)::bigint AS hn_sg_vnd,
          COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN ('FX_FEE','HANDLING','OTHER_LANDED')), 0)::bigint AS other_vnd,
          COALESCE(SUM(a.amount_vnd), 0)::bigint AS landed_cost_vnd,
          COALESCE(bool_or(a.is_estimate), false) AS has_estimate
        FROM items i LEFT JOIN item_cost_allocations a ON a.item_id = i.id
        WHERE i.deleted_at IS NULL GROUP BY i.id, i.batch_id)
      (SELECT * FROM ref EXCEPT SELECT * FROM v_item_landed_cost)
      UNION ALL
      (SELECT * FROM v_item_landed_cost EXCEPT SELECT * FROM ref)`;
    expect(diff).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM v_item_landed_cost`;
    expect(n).toBeGreaterThan(0);
  });

  it("v_item_milestones: chỉ máy có mốc, đủ 9 mốc", async () => {
    const diff = await sql`
      WITH ref AS (
        SELECT item_id,
          MIN(occurred_at) FILTER (WHERE event_type = 'ORDERED') AS ordered_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'SELLER_SHIPPED') AS seller_shipped_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'US_WAREHOUSE_RECEIVED') AS us_warehouse_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'INTL_DEPARTED') AS intl_departed_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'HN_ARRIVED') AS hn_arrived_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'DOMESTIC_DEPARTED') AS domestic_departed_at,
          MIN(occurred_at) FILTER (WHERE event_type = 'SG_RECEIVED') AS sg_received_at,
          MAX(occurred_at) FILTER (WHERE event_type = 'SOLD') AS sold_at,
          MAX(occurred_at) FILTER (WHERE event_type = 'DELIVERED') AS delivered_at
        FROM item_events GROUP BY item_id)
      (SELECT * FROM ref EXCEPT SELECT * FROM v_item_milestones)
      UNION ALL
      (SELECT * FROM v_item_milestones EXCEPT SELECT * FROM ref)`;
    expect(diff).toEqual([]);
  });

  it("listBatches (gom một lượt) = v_batch_summary cho mọi chuyến; lọc một chuyến cho cùng kết quả", async () => {
    const rows = await listBatches(sql);
    const ref = await sql<
      { id: string; item_count: number; sold_count: number; total: string; revenue: string; profit: string; unsold: string; roi: string | null }[]
    >`
      SELECT s.batch_id::text AS id, s.item_count::int, s.sold_count::int, s.total_landed_cost_vnd::text AS total, s.revenue_vnd::text AS revenue,
             s.realized_profit_vnd::text AS profit, s.unsold_cost_vnd::text AS unsold, s.roi_on_sold_pct::text AS roi
        FROM v_batch_summary s JOIN batches b ON b.id = s.batch_id WHERE b.deleted_at IS NULL`;
    expect(rows.length).toBe(ref.length);
    for (const r of ref) {
      const mine = rows.find((x) => x.id === r.id)!;
      expect({
        itemCount: mine.itemCount,
        soldCount: mine.soldCount,
        total: mine.totalLandedCostVnd,
        revenue: mine.revenueVnd,
        profit: mine.realizedProfitVnd,
        unsold: mine.unsoldCostVnd,
        roi: mine.roiOnSoldPct,
      }).toEqual({
        itemCount: r.item_count,
        soldCount: r.sold_count,
        total: BigInt(r.total),
        revenue: BigInt(r.revenue),
        profit: BigInt(r.profit),
        unsold: BigInt(r.unsold),
        roi: r.roi,
      });
    }
    const one = rows.find((x) => x.itemCount > 0)!;
    expect(await listBatches(sql, one.id)).toEqual([one]);
  });
});
