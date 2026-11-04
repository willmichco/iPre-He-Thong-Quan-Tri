/**
 * Kiểm thử tích hợp chi phí theo chặng với PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { costSchema } from "@/domain/costs";
import { validate } from "@/domain/catalog";
import { finalizeBatchCosts, reopenBatchCosts } from "@/server/costing/service";
import * as svc from "@/server/costs/service";

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

const CH011 = "60000000-0000-0000-0000-000000000001";
const SHIP_INTL = "90000000-0000-0000-0000-000000000002";
const SHIP_HNSG = "90000000-0000-0000-0000-000000000003";
const COST_INSURANCE = "a0000000-0000-0000-0000-000000000003";
const IPHONE = "80000000-0000-0000-0000-000000000001";

function cost(over: Record<string, string>) {
  const r = validate(costSchema, { kind: "HANDLING", target: `BATCH:${CH011}`, amount: "90.000", incurredAt: "2026-10-21", ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
const summary = async (tx: TransactionSql) =>
  (await tx<{ s: string }[]>`SELECT total_landed_cost_vnd||'|'||realized_profit_vnd AS s FROM v_batch_summary WHERE batch_id = ${CH011}`)[0].s;
const alloc = async (tx: TransactionSql, costId: string) =>
  (
    await tx<
      { v: string }[]
    >`SELECT a.amount_vnd::text AS v FROM item_cost_allocations a JOIN items i ON i.id = a.item_id WHERE a.cost_id = ${costId} ORDER BY i.id`
  ).map((r) => r.v);

describe("Chi phí theo chặng ↔ PostgreSQL", () => {
  it("đọc chi phí & cấu trúc giá vốn của chuyến ví dụ — khớp tài liệu 01, đối soát với đơn mua", async () => {
    const costs = await svc.listCosts(sql, { batchId: CH011 });
    expect(costs.map((c) => [c.kind, c.targetLabel, c.method, c.amountVnd, c.allocatedVnd, c.allocatedItems])).toEqual([
      ["US_DOMESTIC_SHIPPING", "Kiện 9400000000000000000001", "BY_QUANTITY", 528_000n, 528_000n, 3],
      ["INTL_SHIPPING", "Kiện AWB-0001", "BY_WEIGHT", 684_000n, 684_000n, 3],
      ["INSURANCE", "Kiện AWB-0001", "BY_VALUE", 540_408n, 540_408n, 3],
      ["DOMESTIC_SHIPPING", "Kiện HNSG-0001", "BY_QUANTITY", 150_000n, 150_000n, 3],
    ]);
    expect(await svc.costBreakdown(sql, CH011)).toEqual({
      purchaseVnd: 54_040_800n,
      usDomesticVnd: 528_000n,
      internationalVnd: 1_224_408n,
      hnSgVnd: 150_000n,
      otherVnd: 0n,
      totalVnd: 55_943_208n,
      purchaseOrdersVnd: 54_040_800n,
      hasEstimate: false,
    });
    expect((await svc.listCosts(sql, { shipmentId: SHIP_INTL })).map((c) => c.kind)).toEqual(["INTL_SHIPPING", "INSURANCE"]);
    const t = await svc.costTargets(sql, CH011);
    expect(t.batchCode).toBe("CH-2026-011");
    expect(t.purchaseOrders).toHaveLength(1);
    expect(t.shipments.map((s) => s.leg).sort()).toEqual(["HN_TO_SG", "US_DOMESTIC", "US_TO_VN"]);
  });

  it("chuyến đã chốt: thêm chi phí bị chặn, không lưu gì", async () => {
    await inTx(async (tx) => {
      await expect(svc.saveCost(tx, null, cost({}))).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
      const [n] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM costs WHERE kind = 'HANDLING' AND deleted_at IS NULL`;
      expect(n.n).toBe(0);
    });
  });

  it("mở lại → thêm chi phí (dự toán) → giá vốn & lãi tự cập nhật; còn dự toán thì không chốt được; sửa / xoá", async () => {
    await inTx(async (tx) => {
      await reopenBatchCosts(tx, CH011, "Thêm phí kiểm máy");
      const { id, recalc } = await svc.saveCost(tx, null, cost({ isEstimate: "on", description: "Kiểm máy" }));
      expect(recalc.batches[0]).toMatchObject({ beforeVnd: 55_943_208n, afterVnd: 56_033_208n });
      expect(await alloc(tx, id)).toEqual(["30000", "30000", "30000"]);
      // 2 máy đã bán gánh 60.000 → lãi chuyến giảm đúng 60.000
      expect(await summary(tx)).toBe("56033208|2646128");
      await expect(finalizeBatchCosts(tx, CH011)).rejects.toMatchObject({ code: "BATCH_NOT_READY", message: expect.stringContaining("dự toán") });

      // có hoá đơn thật: 120.000 theo giá trị, hết dự toán
      await svc.saveCost(tx, id, cost({ amount: "120000", method: "BY_VALUE", hasValidInvoice: "on" }));
      // 120.000 × giá mua 31.653.600 / 15.813.600 / 6.573.600 (÷ 54.040.800) = 70.288,1 / 35.114,8 / 14.597,1 → phần dư lớn nhất
      expect(await alloc(tx, id)).toEqual(["70288", "35115", "14597"]);
      await expect(finalizeBatchCosts(tx, CH011)).resolves.toMatchObject({ code: "CH-2026-011" });

      await reopenBatchCosts(tx, CH011, "Xoá khoản trùng");
      await svc.deleteCost(tx, id);
      expect(await alloc(tx, id)).toEqual([]);
      expect(await summary(tx)).toBe("55943208|2706128");
      await expect(svc.deleteCost(tx, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  it("chi phí bằng USD theo tỷ giá riêng của khoản; hoàn phí (số âm) giảm giá vốn; chuyển đối tượng → chuyến tính lại", async () => {
    await inTx(async (tx) => {
      await reopenBatchCosts(tx, CH011, "Phụ thu USD");
      const { id } = await svc.saveCost(
        tx,
        null,
        cost({ kind: "INSURANCE", target: `SHIPMENT:${SHIP_INTL}`, currency: "USD", amount: "12.34", fxRate: "26.400" }),
      );
      const [c] = await tx<{ v: string; fx: string }[]>`SELECT amount_vnd::text AS v, fx_rate::text AS fx FROM costs WHERE id = ${id}`;
      expect(c).toEqual({ v: "325776", fx: "26400.0000" }); // 12,34 × 26.400, cột sinh tự động của CSDL khớp bộ máy
      expect((await alloc(tx, id)).reduce((a, b) => a + Number(b), 0)).toBe(325_776);

      // hoàn 50.000 cước HN→SG
      const refund = await svc.saveCost(tx, null, cost({ kind: "DOMESTIC_SHIPPING", target: `SHIPMENT:${SHIP_HNSG}`, amount: "-50.000" }));
      expect(await alloc(tx, refund.id)).toEqual(["-16667", "-16667", "-16666"]);

      // chuyển khoản USD sang gắn thẳng 1 máy
      await svc.saveCost(tx, id, cost({ kind: "INSURANCE", target: `ITEM:${IPHONE}`, currency: "USD", amount: "12.34", fxRate: "26400" }));
      expect(await alloc(tx, id)).toEqual(["325776"]);
    });
  });

  it("nhập tay từng máy: theo Serial/IMEI, tổng phải khớp, máy phải thuộc đối tượng", async () => {
    await inTx(async (tx) => {
      await reopenBatchCosts(tx, CH011, "Forwarder báo giá từng máy");
      const base = { kind: "INTL_SHIPPING", target: `SHIPMENT:${SHIP_INTL}`, amount: "300.000", method: "MANUAL" };
      await expect(svc.saveCost(tx, null, cost({ ...base, manualShares: "SERIALIPHONE01: 200.000\nSERIALIPAD0001: 50.000" }))).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("lệch 50.000"),
      });
      await expect(svc.saveCost(tx, null, cost({ ...base, manualShares: "KHONGCO: 300000" }))).rejects.toMatchObject({
        message: expect.stringContaining("KHONGCO"),
      });
      await expect(svc.saveCost(tx, null, cost({ ...base, manualShares: "dòng sai" }))).rejects.toMatchObject({ field: "manualShares" });
      await expect(svc.saveCost(tx, null, cost({ ...base }))).rejects.toMatchObject({ field: "manualShares" });
      const { id } = await svc.saveCost(tx, null, cost({ ...base, manualShares: "serialiphone01: 200.000\nSERIALAIRPODS1 = 100000" }));
      expect(await alloc(tx, id)).toEqual(["200000", "100000"]);
      const row = (await svc.listCosts(tx, { batchId: CH011 })).find((c) => c.id === id)!;
      expect(row.manualShares).toBe("SERIALIPHONE01: 200000\nSERIALAIRPODS1: 100000");
    });
  });

  it("kiện chưa có máy / đối tượng không tồn tại → lỗi rõ ràng", async () => {
    await inTx(async (tx) => {
      const [s] = await tx<{ id: string }[]>`INSERT INTO shipments (leg_type) VALUES ('US_TO_VN') RETURNING id::text`;
      await expect(svc.saveCost(tx, null, cost({ target: `SHIPMENT:${s.id}` }))).rejects.toMatchObject({ code: "NO_ITEMS", field: "target" });
      await expect(svc.saveCost(tx, null, cost({ target: "BATCH:69999999-0000-0000-0000-000000000000" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.saveCost(tx, COST_INSURANCE.replace("-000000000003", "-000000000099"), cost({}))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
