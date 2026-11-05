/** Hộp chờ duyệt ↔ PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ. */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { sanitizeRecords } from "@/domain/scan-inbox";
import * as svc from "@/server/scans/service";
import { createBatch, savePurchaseOrder } from "@/server/purchasing/service";
import { createShipment } from "@/server/shipping/service";
import { validate } from "@/domain/catalog";
import { purchaseOrderSchema } from "@/domain/purchasing";

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

// IMEI hợp lệ (Luhn) chưa có trong dữ liệu ví dụ
const IMEI_A = "356938035643809";
const IMEI_B = "490154203237518";
const rec = (id: string, f: Record<string, string>, source = "BARCODE") => ({
  id,
  origin: "PHOTO",
  fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { value: v, source }])),
});
async function newPo(tx: TransactionSql) {
  const b = await createBatch(tx, { code: "CH-TEST-HOP", name: null, plannedFxRate: null, note: null });
  const r = validate(purchaseOrderSchema, { supplierId: "30000000-0000-0000-0000-000000000001", orderedAt: "2026-11-01", subtotal: "2398", fxRate: "26.400" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return (await savePurchaseOrder(tx, b.id, null, r.data)).id;
}

describe("Hộp chờ duyệt ↔ PostgreSQL", () => {
  it("gửi vào hộp chờ (không gửi trùng), soát từng dòng, sửa, bỏ", async () => {
    await inTx(async (tx) => {
      const recs = sanitizeRecords([
        rec("p1", { serial: "SERIALHOP001", imei1: IMEI_A, partNumber: "MDEM1LL/A" }),
        rec("p2", { serial: "SERIALAIRPODS1" }),
        rec("p3", { imei1: "350000000000007" }),
      ]);
      expect(await svc.submitCaptures(tx, recs)).toEqual({ added: 3, skipped: 0 });
      expect(await svc.submitCaptures(tx, recs)).toEqual({ added: 0, skipped: 3 }); // gửi lại phiên cũ
      const rows = await svc.listInbox(tx);
      expect(rows.map((r) => [r.fields.serial?.value ?? r.fields.imei1?.value, r.level, r.variant?.label ?? null])).toEqual([
        ["SERIALHOP001", "OK", "iPhone Pro Max · 256GB · Silver"],
        ["SERIALAIRPODS1", "WARN", null],
        ["350000000000007", "ERROR", null],
      ]);
      expect(rows[1].existingItemIds).toEqual(["80000000-0000-0000-0000-000000000003"]);
      expect(rows[1].issues.at(-1)!.message).toContain("SERIALAIRPODS1 đã có trong hệ thống: chuyến CH-2026-011");

      await svc.updateCapture(tx, rows[2].id, { imei1: IMEI_B, serial: "serialhop003" });
      const fixed = (await svc.listInbox(tx)).find((r) => r.id === rows[2].id)!;
      expect(fixed.fields).toEqual({ imei1: { value: IMEI_B, source: "MANUAL" }, serial: { value: "SERIALHOP003", source: "MANUAL" } });
      expect(fixed.level).toBe("WARN"); // còn thiếu Part No.

      expect(await svc.discardCaptures(tx, [rows[1].id])).toBe(1);
      expect(await svc.inboxCount(tx)).toBe(2);
      await expect(svc.discardCaptures(tx, [rows[1].id])).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  it("xác nhận vào đơn mua: tạo máy (cấu hình theo Part No. / chọn chung), ghép dòng ↔ máy; lỗi → không tạo gì", async () => {
    await inTx(async (tx) => {
      const poId = await newPo(tx);
      await svc.submitCaptures(
        tx,
        sanitizeRecords([rec("a", { serial: "SERIALHOP001", imei1: IMEI_A, partNumber: "MDEM1LL/A" }), rec("b", { serial: "SERIALHOP002", imei1: IMEI_B })]),
      );
      const rows = await svc.listInbox(tx);
      const ids = rows.map((r) => r.id);
      await expect(svc.confirmIntoPurchaseOrder(tx, ids, { purchaseOrderId: poId, unitPrice: "1199" })).rejects.toMatchObject({
        field: "variantId",
        rowErrors: [{ id: ids[1] }],
      });
      const ipad = "20000000-0000-0000-0000-000000000002";
      const r = await svc.confirmIntoPurchaseOrder(tx, ids, { purchaseOrderId: poId, unitPrice: "1.199", variantId: ipad });
      expect(r.created).toBe(2);
      const items = await tx<{ serial_number: string; variant_id: string; unit_price: string; status: string }[]>`
        SELECT serial_number, variant_id::text, unit_price::text, status::text FROM items WHERE purchase_order_id = ${poId} ORDER BY serial_number`;
      expect(items).toEqual([
        { serial_number: "SERIALHOP001", variant_id: "20000000-0000-0000-0000-000000000001", unit_price: "1199.00", status: "ORDERED" },
        { serial_number: "SERIALHOP002", variant_id: ipad, unit_price: "1199.00", status: "ORDERED" },
      ]);
      const caps = await tx<{ status: string; ok: boolean }[]>`
        SELECT status::text, item_id IS NOT NULL AND context_id = ${poId} AS ok FROM scan_captures WHERE id = ANY(${ids}::uuid[])`;
      expect(caps).toEqual([
        { status: "CONFIRMED", ok: true },
        { status: "CONFIRMED", ok: true },
      ]);
      expect(await svc.inboxCount(tx)).toBe(0);

      // máy đã có (trùng Serial) → lỗi của lưới nhập máy, hộp chờ giữ nguyên
      await svc.submitCaptures(tx, sanitizeRecords([rec("c", { serial: "SERIALAIRPODS1", partNumber: "MDEM1LL/A" })]));
      const [dup] = await svc.listInbox(tx);
      await expect(svc.confirmIntoPurchaseOrder(tx, [dup.id], { purchaseOrderId: poId, unitPrice: "1" })).rejects.toMatchObject({ code: "INVALID_ROWS" });
    });
  });

  it("xác nhận vào kiện: máy đã có được nhận vào kiện; dòng không khớp được giữ lại", async () => {
    await inTx(async (tx) => {
      const sid = await createShipment(tx, {
        legType: "SG_LOCAL",
        carrierId: null,
        batchId: null,
        trackingNumber: "NOI-THANH-1",
        referenceCode: null,
        eta: null,
        chargeableWeightKg: null,
        note: null,
      });
      await svc.submitCaptures(tx, sanitizeRecords([rec("x", { serial: "SERIALAIRPODS1" }), rec("y", { serial: "KHONGCOMAYNAY" })]));
      const rows = await svc.listInbox(tx);
      const r = await svc.confirmIntoShipment(
        tx,
        rows.map((x) => x.id),
        sid,
      );
      expect(r).toMatchObject({ confirmed: 1, kept: 1, rejected: [{ code: "KHONGCOMAYNAY" }] });
      expect((await svc.listInbox(tx)).map((x) => x.fields.serial?.value)).toEqual(["KHONGCOMAYNAY"]);
      const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM shipment_items WHERE shipment_id = ${sid}`;
      expect(n).toBe(1);
    });
  });
});
