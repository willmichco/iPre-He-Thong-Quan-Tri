/**
 * Kiểm thử tích hợp trang Tổng quan với PostgreSQL thật (đã nạp db/seed-vi-du.sql). Ca có ghi dữ liệu chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@/domain/catalog";
import { periodRange } from "@/domain/overview";
import { emptyRow, purchaseOrderSchema } from "@/domain/purchasing";
import { saleSchema } from "@/domain/sales";
import { getOverview, listItemsAtStatuses } from "@/server/overview/service";
import * as purchasing from "@/server/purchasing/service";
import * as sales from "@/server/sales/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

class Rollback extends Error {}
async function inTx(fn: (tx: TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const TODAY = "2026-11-04";
const OCT = periodRange("thang-truoc", TODAY);
const BANK = "50000000-0000-0000-0000-000000000002";
const AIRPODS = "80000000-0000-0000-0000-000000000003";

describe("Tổng quan ↔ PostgreSQL", () => {
  it("dữ liệu mẫu: lãi tháng 10 khớp v_batch_summary, vốn tồn SG = máy AirPods chưa bán", async () => {
    const o = await getOverview(sql, OCT, TODAY);
    expect(o.current).toMatchObject({ units: 2, revenueVnd: 51_700_000n, cogsVnd: 48_963_872n, profitVnd: 2_706_128n, provisional: 0, marginBp: 523 });
    const sg = o.capital.stages.find((s) => s.key === "sg")!;
    expect(sg.capitalVnd).toBeGreaterThanOrEqual(6_979_336n);
    expect(o.months).toHaveLength(12);
    expect(o.months.find((m) => m.month === "2026-10-01")).toMatchObject({ units: 2, revenueVnd: 51_700_000n, profitVnd: 2_706_128n });
    expect(o.categories.map((c) => c.category).sort()).toEqual(["IPAD", "IPHONE"]);
    expect(o.categories.reduce((a, c) => a + c.profitVnd, 0n)).toBe(2_706_128n);
    // kỳ trước (tháng 9) không bán gì
    expect(o.previous.units).toBe(0);
    // đối chiếu tổng vốn với view gốc
    const [v] = await sql<{ c: string }[]>`SELECT COALESCE(SUM(capital_vnd), 0)::text AS c FROM v_capital_by_stage`;
    expect(o.capital.totalVnd).toBe(BigInt(v.c));
  });

  it("máy khách đã cọc nhưng còn ở kho Mỹ: vốn tính ở 'Kho Mỹ'; về SG thì nhắc giao đơn cọc", async () => {
    await inTx(async (tx) => {
      const b = await purchasing.createBatch(tx, { code: "CH-TEST-950", name: null, plannedFxRate: null, note: null });
      const po = validate(purchaseOrderSchema, {
        supplierId: "30000000-0000-0000-0000-000000000001",
        orderedAt: "2026-10-25",
        subtotal: "1000",
        fxRate: "25000",
      });
      if (!po.ok) throw new Error("po");
      const { id: poId } = await purchasing.savePurchaseOrder(tx, b.id, null, po.data);
      await purchasing.saveItems(tx, poId, [{ ...emptyRow(), variantId: "20000000-0000-0000-0000-000000000001", unitPrice: "1000", imei1: "356938035643809" }]);
      const [it] = await tx<{ id: string }[]>`UPDATE items SET status = 'AT_US_WAREHOUSE' WHERE imei1 = '356938035643809' RETURNING id::text`;
      await tx`INSERT INTO item_events (item_id, event_type, occurred_at) VALUES (${it.id}, 'SELLER_SHIPPED', now()), (${it.id}, 'US_WAREHOUSE_RECEIVED', now())`;

      const before = await getOverview(tx, OCT, TODAY);
      const usWh = (o: typeof before) => o.capital.stages.find((s) => s.key === "us-wh")!;
      expect(usWh(before).capitalVnd).toBeGreaterThanOrEqual(25_000_000n);

      const input = validate(saleSchema, {
        lines: [{ itemId: it.id, price: "30tr" }],
        payment: "DEPOSIT",
        paidAmount: "5tr",
        accountId: BANK,
        customerName: "Chị Bình",
      });
      if (!input.ok) throw new Error(JSON.stringify(input.errors));
      const s = await sales.createSale(tx, input.data, new Date("2026-11-04T03:00:00Z"));

      const after = await getOverview(tx, OCT, TODAY);
      expect(usWh(after)).toEqual(usWh(before)); // RESERVED nhưng vẫn nằm ở kho Mỹ
      expect((await listItemsAtStatuses(tx, ["AT_US_WAREHOUSE"])).map((r) => r.id)).toContain(it.id);
      expect((await listItemsAtStatuses(tx, ["IN_STOCK", "RESERVED"])).map((r) => r.id)).not.toContain(it.id);
      expect(after.alerts.some((a) => a.kind === "DEPOSIT_READY")).toBe(false);
      expect(after.activeBatches.find((x) => x.code === "CH-TEST-950")).toMatchObject({ itemCount: 1, byStage: { "us-wh": 1 } });

      await tx`INSERT INTO item_events (item_id, event_type, occurred_at) VALUES (${it.id}, 'SG_RECEIVED', now())`;
      const ready = await getOverview(tx, OCT, TODAY);
      expect(ready.alerts.find((a) => a.kind === "DEPOSIT_READY")).toMatchObject({ href: `/ban-hang/${s.id}` });
      expect(ready.capital.stages.find((x) => x.key === "sg")!.itemCount).toBe(after.capital.stages.find((x) => x.key === "sg")!.itemCount + 1);
    });
  });

  it("cảnh báo: kiện trễ ETA, kiện giữ hải quan, khách còn nợ, hạn đổi trả, ngưỡng doanh thu", async () => {
    await inTx(async (tx) => {
      await tx`INSERT INTO shipments (leg_type, tracking_number, status, shipped_at, eta) VALUES ('US_TO_VN', 'AWB-TRE', 'IN_TRANSIT', '2026-10-20', '2026-10-30')`;
      const [h] = await tx<{ id: string }[]>`
        INSERT INTO shipments (leg_type, tracking_number, status, shipped_at, eta) VALUES ('US_TO_VN', 'AWB-GIU', 'HOLD', '2026-10-20', '2026-11-10') RETURNING id::text`;
      await tx`INSERT INTO shipment_tracking_events (shipment_id, occurred_at, description) VALUES (${h.id}, '2026-11-01T02:00:00Z', 'Bị giữ hải quan: thiếu chứng từ')`;
      const input = validate(saleSchema, { lines: [{ itemId: AIRPODS, price: "7,5tr" }], payment: "UNPAID", customerName: "Anh Nợ" });
      if (!input.ok) throw new Error(JSON.stringify(input.errors));
      await sales.createSale(tx, input.data, new Date("2026-11-04T03:00:00Z"));
      await tx`UPDATE purchase_orders SET return_deadline = '2026-11-06' WHERE batch_id = '60000000-0000-0000-0000-000000000001'`;
      await tx`UPDATE items SET status = 'DAMAGED' WHERE id = ${AIRPODS}`;
      await tx`UPDATE app_settings SET value = '50000000' WHERE key = 'tax.revenue_threshold_vnd'`;

      const o = await getOverview(tx, periodRange("thang-nay", TODAY), TODAY);
      const kinds = o.alerts.map((a) => a.kind);
      expect(kinds).toEqual(expect.arrayContaining(["SHIPMENT_HOLD", "SHIPMENT_LATE", "RECEIVABLE", "RETURN_DEADLINE", "TAX_THRESHOLD"]));
      expect(o.alerts.find((a) => a.kind === "SHIPMENT_HOLD")!.title).toBe("Kiện AWB-GIU đang bị giữ hải quan 3 ngày");
      expect(o.alerts.find((a) => a.kind === "SHIPMENT_LATE")!.title).toBe("Kiện AWB-TRE trễ 5 ngày so với dự kiến");
      expect(o.alerts.find((a) => a.title.startsWith("Đơn mua"))!.title).toContain("còn 2 ngày hết hạn đổi trả");
      expect(o.receivableVnd).toBeGreaterThanOrEqual(7_500_000n);
      expect(o.current).toMatchObject({ units: 1, revenueVnd: 7_500_000n });
      expect(o.alerts[0].level).toBe("critical");
    });
  });
});
