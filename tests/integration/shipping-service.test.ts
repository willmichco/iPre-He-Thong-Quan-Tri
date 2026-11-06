/**
 * Kiểm thử tích hợp Kiện 3 chặng với PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { emptyRow, purchaseOrderSchema, validate } from "@/domain/purchasing";
import { shipmentSchema } from "@/domain/shipping";
import * as purchasing from "@/server/purchasing/service";
import * as svc from "@/server/shipping/service";
import { reopenBatchCosts } from "@/server/costing/service";

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

const SUPPLIER = "30000000-0000-0000-0000-000000000001";
const USPS = "40000000-0000-0000-0000-000000000001";
const FORWARDER = "40000000-0000-0000-0000-000000000002";
const CHANH = "40000000-0000-0000-0000-000000000003";
const IPHONE = "20000000-0000-0000-0000-000000000001";
const SHIP_HNSG_011 = "90000000-0000-0000-0000-000000000003";
const IMEI = ["356938035643809", "490154203237518", "352099001761481"];

function shipment(over: Record<string, string>) {
  const r = validate(shipmentSchema, over);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

/** Chuyến nháp 3 iPhone (IMEI ở trên), đơn 3 × 1.000 USD × 25.000. */
async function fixture(tx: TransactionSql) {
  const b = await purchasing.createBatch(tx, { code: "CH-TEST-700", name: null, plannedFxRate: null, note: null });
  const po = validate(purchaseOrderSchema, { supplierId: SUPPLIER, orderedAt: "2026-10-01", subtotal: "3000", fxRate: "25000" });
  if (!po.ok) throw new Error("po");
  const { id: poId } = await purchasing.savePurchaseOrder(tx, b.id, null, po.data);
  await purchasing.saveItems(
    tx,
    poId,
    IMEI.map((imei, k) => ({ ...emptyRow(), variantId: IPHONE, unitPrice: "1000", imei1: imei, serial: `TESTSER00${k}` })),
  );
  return b.id;
}
const statuses = async (tx: TransactionSql) =>
  (await tx<{ s: string }[]>`SELECT status::text AS s FROM items WHERE imei1 = ANY(${IMEI}) ORDER BY array_position(${IMEI}::text[], imei1)`).map((r) => r.s);
const batchStatus = async (tx: TransactionSql, id: string) => (await tx<{ s: string }[]>`SELECT status::text AS s FROM batches WHERE id = ${id}`)[0].s;

describe("Kiện 3 chặng ↔ PostgreSQL", () => {
  it("trọn hành trình: gán máy (quét) → Gửi đi / Đã nhận ở 3 chặng → mốc M2–M7 cho mọi máy, trạng thái & chuyến tự cập nhật", async () => {
    await inTx(async (tx) => {
      const batchId = await fixture(tx);
      const us = await svc.createShipment(tx, shipment({ legType: "US_DOMESTIC", carrierId: USPS, trackingNumber: "9400 1111 2222", batchId }));
      // quét: Serial, IMEI (cả "S" đầu mã vạch serial đã bỏ ở bước đọc), mã lạ, quét trùng cùng máy
      const r = await svc.assignItems(tx, us, ["TESTSER000", IMEI[1], IMEI[2], "KHONGCO123", IMEI[0]]);
      expect(r.added.map((a) => a.code)).toEqual(["TESTSER000", IMEI[1], IMEI[2]]);
      expect(r.rejected).toEqual([{ code: "KHONGCO123", reason: expect.stringContaining("Không có máy nào") }]);
      const again = await svc.assignItems(tx, us, [IMEI[0]]);
      expect(again.rejected).toEqual([{ code: IMEI[0], reason: "Đã có trong kiện này" }]);

      await expect(svc.markArrived(tx, us, "2026-10-05T10:00:00+07:00")).rejects.toMatchObject({ code: "INVALID_STATE" });
      await tx`UPDATE carriers SET default_lead_days = 4 WHERE id = ${USPS}`;
      expect(await svc.markShipped(tx, us, "2026-10-02T09:00:00+07:00")).toEqual({ itemCount: 3, eta: "2026-10-06" });
      expect(await statuses(tx)).toEqual(["US_IN_TRANSIT", "US_IN_TRANSIT", "US_IN_TRANSIT"]);
      expect(await batchStatus(tx, batchId)).toBe("IN_TRANSIT");
      await expect(svc.markShipped(tx, us, "2026-10-02T09:00:00+07:00")).rejects.toMatchObject({ code: "INVALID_STATE" });
      await expect(svc.markArrived(tx, us, "2026-10-01T09:00:00+07:00")).rejects.toMatchObject({ code: "INVALID_INPUT", field: "at" });
      await svc.markArrived(tx, us, "2026-10-05T15:00:00+07:00");
      expect(await statuses(tx)).toEqual(["AT_US_WAREHOUSE", "AT_US_WAREHOUSE", "AT_US_WAREHOUSE"]);

      // chặng 2: khách cọc 1 máy trước khi về (đặt trước) → giữ "Khách cọc" suốt đường về
      await tx`UPDATE items SET status = 'RESERVED' WHERE imei1 = ${IMEI[2]}`;
      const intl = await svc.createShipment(tx, shipment({ legType: "US_TO_VN", carrierId: FORWARDER, referenceCode: "AWB-7" }));
      await svc.assignItems(tx, intl, IMEI);
      await svc.markShipped(tx, intl, "2026-10-08T12:00:00+07:00");
      await svc.setHold(tx, intl, true, "thiếu chứng từ");
      expect((await svc.getShipment(tx, intl))!.status).toBe("HOLD");
      await expect(svc.setHold(tx, intl, true)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await svc.markArrived(tx, intl, "2026-10-17T09:00:00+07:00"); // nhận thẳng từ trạng thái giữ
      expect(await statuses(tx)).toEqual(["AT_HN", "AT_HN", "RESERVED"]);

      const hnsg = await svc.createShipment(tx, shipment({ legType: "HN_TO_SG", carrierId: CHANH }));
      await svc.assignItems(tx, hnsg, IMEI);
      await svc.markShipped(tx, hnsg, "2026-10-18T08:00:00+07:00");
      expect(await batchStatus(tx, batchId)).toBe("IN_TRANSIT");
      await svc.markArrived(tx, hnsg, "2026-10-20T16:00:00+07:00");
      expect(await statuses(tx)).toEqual(["IN_STOCK", "IN_STOCK", "RESERVED"]);
      expect(await batchStatus(tx, batchId)).toBe("ARRIVED");

      // mốc M1–M7 của 1 máy, đúng thứ tự, gắn đúng kiện
      const events = await tx<{ e: string; at: string }[]>`
        SELECT e.event_type::text AS e, to_char(e.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS at
          FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.imei1 = ${IMEI[0]} ORDER BY e.occurred_at`;
      expect(events).toEqual([
        { e: "ORDERED", at: "01/10 12:00" },
        { e: "SELLER_SHIPPED", at: "02/10 09:00" },
        { e: "US_WAREHOUSE_RECEIVED", at: "05/10 15:00" },
        { e: "INTL_DEPARTED", at: "08/10 12:00" },
        { e: "HN_ARRIVED", at: "17/10 09:00" },
        { e: "DOMESTIC_DEPARTED", at: "18/10 08:00" },
        { e: "SG_RECEIVED", at: "20/10 16:00" },
      ]);
      // thời gian từng chặng (view v_item_lead_times)
      const [lt] = await tx<{ us: string; intl: string; total: string }[]>`
        SELECT round(us_domestic_days, 2)::text AS us, round(international_days, 2)::text AS intl, round(order_to_stock_days, 2)::text AS total
          FROM v_item_lead_times t JOIN items i ON i.id = t.item_id WHERE i.imei1 = ${IMEI[0]}`;
      expect(lt).toEqual({ us: "3.25", intl: "8.88", total: "19.17" });

      // bảng tiến độ chỉ giữ kiện đã nhận trong N ngày gần đây
      expect((await svc.listShipments(tx, 1)).some((x) => x.id === us)).toBe(false);
      const list = await svc.listShipments(tx, 3650);
      expect(list.find((x) => x.id === us)).toMatchObject({ status: "ARRIVED", itemCount: 3, batchCodes: ["CH-TEST-700"], valueVnd: 75_000_000n });
    });
  });

  it("mỗi máy chỉ 1 kiện / chặng; máy đã bán không gán được; bỏ máy chỉ khi kiện chưa gửi; kiện đã gửi không xoá được", async () => {
    await inTx(async (tx) => {
      await fixture(tx);
      const a = await svc.createShipment(tx, shipment({ legType: "US_DOMESTIC", trackingNumber: "A1" }));
      const b = await svc.createShipment(tx, shipment({ legType: "US_DOMESTIC", trackingNumber: "B1" }));
      await svc.assignItems(tx, a, [IMEI[0]]);
      expect((await svc.assignItems(tx, b, [IMEI[0]])).rejected).toEqual([{ code: IMEI[0], reason: "Đã nằm trong kiện A1 cùng chặng" }]);
      // máy đã bán (dữ liệu ví dụ) không đi tiếp được
      const local = await svc.createShipment(tx, shipment({ legType: "SG_LOCAL" }));
      expect((await svc.assignItems(tx, local, ["SERIALIPHONE01"])).rejected[0].reason).toContain("SOLD");
      const intl = await svc.createShipment(tx, shipment({ legType: "US_TO_VN" }));
      expect((await svc.assignItems(tx, intl, ["SERIALIPHONE01"])).rejected[0].reason).toBe("Đã nằm trong kiện AWB-0001 cùng chặng");

      await svc.removeItem(tx, a, (await svc.getShipment(tx, a))!.items[0].id);
      expect((await svc.getShipment(tx, a))!.itemCount).toBe(0);
      await expect(svc.markShipped(tx, a, "2026-10-02T09:00:00+07:00")).rejects.toMatchObject({ message: expect.stringContaining("chưa có máy") });
      await svc.assignItems(tx, a, IMEI);
      await svc.markShipped(tx, a, "2026-10-02T09:00:00+07:00");
      const item = (await svc.getShipment(tx, a))!.items[0].id;
      await expect(svc.removeItem(tx, a, item)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await expect(svc.deleteShipment(tx, a)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await svc.deleteShipment(tx, b);
      expect(await svc.getShipment(tx, b)).toBeNull();
    });
  });

  it("thêm máy vào kiện đã gửi → máy nhận luôn mốc gửi; kiện có cước → giá vốn chia lại; chuyến đã chốt → chặn", async () => {
    await inTx(async (tx) => {
      await fixture(tx);
      const s = await svc.createShipment(tx, shipment({ legType: "US_DOMESTIC", trackingNumber: "C1" }));
      await svc.assignItems(tx, s, [IMEI[0], IMEI[1]]);
      await tx`
        INSERT INTO costs (kind, shipment_id, amount, allocation_method, incurred_at) VALUES ('US_DOMESTIC_SHIPPING', ${s}, 90000, 'BY_QUANTITY', now())`;
      await svc.assignItems(tx, s, []); // không thêm gì → không tính lại
      await svc.markShipped(tx, s, "2026-10-02T09:00:00+07:00");
      const r = await svc.assignItems(tx, s, [IMEI[2]]);
      expect(r.recalc?.batches[0]).toMatchObject({ code: "CH-TEST-700" });
      const alloc = await tx<{ v: string }[]>`
        SELECT a.amount_vnd::text AS v FROM item_cost_allocations a JOIN items i ON i.id = a.item_id
         WHERE a.component = 'US_DOMESTIC_SHIPPING' AND i.imei1 = ANY(${IMEI}) ORDER BY array_position(${IMEI}::text[], i.imei1)`;
      expect(alloc.map((x) => x.v)).toEqual(["30000", "30000", "30000"]);
      expect(await statuses(tx)).toEqual(["US_IN_TRANSIT", "US_IN_TRANSIT", "US_IN_TRANSIT"]);
      await expect(svc.deleteShipment(tx, s)).rejects.toMatchObject({ code: "INVALID_STATE" });

      // gom máy chuyến mới vào kiện HN→SG của chuyến đã chốt → cước chia lại → chặn
      await expect(svc.assignItems(tx, SHIP_HNSG_011, [IMEI[0]])).rejects.toMatchObject({ code: "INVALID_STATE" }); // kiện đã nhận
      await tx`UPDATE shipments SET status = 'IN_TRANSIT', arrived_at = NULL WHERE id = ${SHIP_HNSG_011}`;
      await expect(svc.assignItems(tx, SHIP_HNSG_011, [IMEI[0]])).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
      await reopenBatchCosts(tx, "60000000-0000-0000-0000-000000000001", "gom thêm máy");
      expect((await svc.assignItems(tx, SHIP_HNSG_011, [IMEI[0]])).added).toHaveLength(1);
    });
  });

  it("đơn vị vận chuyển phải phục vụ đúng chặng; sửa kiện; tuỳ chọn", async () => {
    await inTx(async (tx) => {
      await expect(svc.createShipment(tx, shipment({ legType: "HN_TO_SG", carrierId: USPS }))).rejects.toMatchObject({
        code: "INVALID_INPUT",
        field: "carrierId",
      });
      const id = await svc.createShipment(tx, shipment({ legType: "US_TO_VN", carrierId: FORWARDER }));
      await svc.updateShipment(
        tx,
        id,
        shipment({ legType: "US_TO_VN", carrierId: FORWARDER, referenceCode: "AWB-9", eta: "2026-11-20", chargeableWeightKg: "2,4" }),
      );
      expect(await svc.getShipment(tx, id)).toMatchObject({
        referenceCode: "AWB-9",
        eta: "2026-11-20",
        chargeableWeightKg: "2.400",
        carrierName: "Forwarder A",
      });
      const opts = await svc.shippingOptions(tx);
      expect(opts.carriers.find((c) => c.id === USPS)).toMatchObject({ legTypes: ["US_DOMESTIC"] });
      await expect(svc.markShipped(tx, "91000000-0000-0000-0000-000000000000", "2026-10-02T09:00:00+07:00")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
  it("nhận kiện bằng quét đối chiếu: thiếu máy → chặn nếu chưa xác nhận; nhận phần đã quét, máy thiếu giữ đang vận chuyển + sự cố; nhận bổ sung đóng sự cố", async () => {
    await inTx(async (tx) => {
      const batchId = await fixture(tx);
      const hnsg = await svc.createShipment(tx, shipment({ legType: "HN_TO_SG", carrierId: CHANH, trackingNumber: "HNSG-77" }));
      await svc.assignItems(tx, hnsg, IMEI);
      await svc.markShipped(tx, hnsg, "2026-10-18T08:00:00+07:00");
      const at = "2026-10-20T16:00:00+07:00";

      // máy 0 quét Serial (mã vạch có tiền tố "S"), máy 1 quét IMEI; máy 2 không quét; 1 mã lạ, 1 máy của kiện khác
      const scanned = ["STESTSER000", IMEI[1], IMEI[1], "KHONGCO999", "SERIALIPHONE01"];
      await expect(svc.receiveByScan(tx, hnsg, [], at, true)).rejects.toMatchObject({ code: "INVALID_INPUT", field: "codes" });
      await expect(svc.receiveByScan(tx, hnsg, scanned, at, false)).rejects.toMatchObject({ code: "INVALID_STATE", field: "acceptShortage" });
      expect((await svc.getShipment(tx, hnsg))!.status).toBe("IN_TRANSIT"); // bị chặn → không ghi gì

      const r = await svc.receiveByScan(tx, hnsg, scanned, at, true);
      expect(r.received).toBe(2);
      expect(r.missing.map((m) => m.code)).toEqual(["TESTSER002"]);
      expect(r.outside).toEqual([
        { code: "KHONGCO999", reason: expect.stringContaining("Chưa có trong hệ thống") },
        { code: "SERIALIPHONE01", reason: expect.stringContaining("Thuộc kiện") },
      ]);
      expect((await svc.getShipment(tx, hnsg))!.status).toBe("ARRIVED");
      expect(await statuses(tx)).toEqual(["IN_STOCK", "IN_STOCK", "DOMESTIC_IN_TRANSIT"]);
      expect(await batchStatus(tx, batchId)).toBe("IN_TRANSIT"); // còn 1 máy chưa về → chuyến chưa "Đã về"
      const [ev] = await tx<{ d: string }[]>`SELECT description AS d FROM shipment_tracking_events WHERE shipment_id = ${hnsg}`;
      expect(ev.d).toBe("Nhận thiếu 1 máy: TESTSER002");

      const open = await svc.listShortages(tx, hnsg);
      expect(open.map((o) => o.serial)).toEqual(["TESTSER002"]);
      expect((await svc.listShortages(tx)).some((o) => o.serial === "TESTSER002")).toBe(true);
      await expect(svc.receiveLateItem(tx, hnsg, open[0].itemId, "2026-10-17T00:00:00+07:00")).rejects.toMatchObject({ field: "at" });
      await expect(svc.receiveLateItem(tx, hnsg, (await svc.getShipment(tx, hnsg))!.items[0].id, at)).rejects.toMatchObject({ code: "NOT_FOUND" });

      await svc.receiveLateItem(tx, hnsg, open[0].itemId, "2026-10-22T10:00:00+07:00");
      expect(await statuses(tx)).toEqual(["IN_STOCK", "IN_STOCK", "IN_STOCK"]);
      expect(await svc.listShortages(tx, hnsg)).toEqual([]);
      expect(await batchStatus(tx, batchId)).toBe("ARRIVED");
      await expect(svc.receiveByScan(tx, hnsg, IMEI, at, true)).rejects.toMatchObject({ code: "INVALID_STATE" }); // nhận rồi
    });
  });

  it("nhận kiện bằng quét: quét đủ → nhận luôn, không cần xác nhận thiếu, không có sự cố", async () => {
    await inTx(async (tx) => {
      await fixture(tx);
      const us = await svc.createShipment(tx, shipment({ legType: "US_DOMESTIC", carrierId: USPS, trackingNumber: "US-88" }));
      await svc.assignItems(tx, us, IMEI);
      await svc.markShipped(tx, us, "2026-10-02T09:00:00+07:00");
      const r = await svc.receiveByScan(tx, us, ["TESTSER000", "TESTSER001", IMEI[2], IMEI[0]], "2026-10-05T15:00:00+07:00", false);
      expect(r).toEqual({ received: 3, missing: [], outside: [] });
      expect(await statuses(tx)).toEqual(["AT_US_WAREHOUSE", "AT_US_WAREHOUSE", "AT_US_WAREHOUSE"]);
      expect(await svc.listShortages(tx, us)).toEqual([]);
    });
  });
});
