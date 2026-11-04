/**
 * Kiểm thử tích hợp Chuyến · Đơn mua · Máy với PostgreSQL thật (đã nạp db/seed-vi-du.sql).
 * Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { emptyRow, purchaseOrderSchema, validate, type GridRow } from "@/domain/purchasing";
import * as svc from "@/server/purchasing/service";
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

const CH011 = "60000000-0000-0000-0000-000000000001";
const PO011 = "70000000-0000-0000-0000-000000000001";
const SUPPLIER = "30000000-0000-0000-0000-000000000001";
const IPHONE = "20000000-0000-0000-0000-000000000001";
const IPAD = "20000000-0000-0000-0000-000000000002";
const IMEI_A = "356938035643809"; // hợp lệ Luhn
const IMEI_B = "490154203237518";

function po(over: Record<string, string> = {}) {
  const r = validate(purchaseOrderSchema, {
    supplierId: SUPPLIER,
    orderNumber: "W999",
    orderedAt: "2026-11-01",
    currency: "USD",
    subtotal: "1,798.00",
    salesTax: "0",
    sellerShipping: "",
    discount: "",
    fxRate: "26.350",
    fxFeeVnd: "",
    paymentAccountId: "",
    paidAt: "",
    returnDeadline: "",
    note: "",
    ...over,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
const row = (over: Partial<GridRow>): GridRow => ({ ...emptyRow(), ...over });

describe("Chuyến · Đơn mua · Máy ↔ PostgreSQL", () => {
  it("chuyến: mã tự sinh tuần tự CH-năm-số, trùng mã → lỗi; danh sách kèm tổng hợp", async () => {
    await inTx(async (tx) => {
      const year = new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric" });
      await tx`INSERT INTO batches (code) VALUES (${`CH-${year}-041`})`;
      const a = await svc.createBatch(tx, { code: null, name: "Chuyến thử", plannedFxRate: "26400.0000", note: null });
      expect(a.code).toBe(`CH-${year}-042`);
      await expect(svc.createBatch(tx, { code: a.code, name: null, plannedFxRate: null, note: null })).rejects.toMatchObject({
        code: "DUPLICATE",
        field: "code",
      });
      const list = await svc.listBatches(tx);
      expect(list.find((b) => b.id === a.id)).toMatchObject({ status: "DRAFT", itemCount: 0, totalLandedCostVnd: 0n });
      expect(list.find((b) => b.id === CH011)).toMatchObject({ itemCount: 3, soldCount: 2, totalLandedCostVnd: 55_943_208n, realizedProfitVnd: 2_706_128n });
      await svc.updateBatch(tx, a.id, { code: null, name: "Đổi tên", plannedFxRate: null, note: "ghi chú" });
      expect((await svc.getBatch(tx, a.id))!).toMatchObject({ code: a.code, name: "Đổi tên", note: "ghi chú" });
      await svc.deleteBatch(tx, a.id);
      await expect(svc.deleteBatch(tx, CH011)).rejects.toMatchObject({ code: "IN_USE" });
    });
  });

  it("đơn mua + lưới máy: thêm máy (mốc Đã đặt), giá vốn tự tính theo tỷ giá thực tế; hạn đổi trả tự tính", async () => {
    await inTx(async (tx) => {
      const b = await svc.createBatch(tx, { code: "CH-TEST-500", name: null, plannedFxRate: null, note: null });
      const { id: poId } = await svc.savePurchaseOrder(tx, b.id, null, po());
      const r = await svc.saveItems(tx, poId, [
        row({ variantId: IPHONE, unitPrice: "1199", serial: "f2lxq7y9zz", imei1: IMEI_A, partNumber: "MDEM1LL/A" }),
        row({ variantId: IPAD, unitPrice: "$599.00" }),
        emptyRow(), // dòng trống bị bỏ qua
      ]);
      expect(r).toMatchObject({ inserted: 2, updated: 0, deleted: 0 });
      const detail = (await svc.getBatch(tx, b.id))!;
      expect(detail.status).toBe("PURCHASING");
      const order = detail.orders[0];
      // Apple Store đổi trả 14 ngày → 15/11
      expect(order).toMatchObject({ orderedAt: "2026-11-01", returnDeadline: "2026-11-15", totalVnd: 47_377_300n });
      expect(order.items.map((i) => [i.serial, i.status, i.landedCostVnd])).toEqual([
        ["F2LXQ7Y9ZZ", "ORDERED", 31_593_650n],
        [null, "ORDERED", 15_783_650n],
      ]);
      expect(detail.summary.totalLandedCostVnd).toBe(47_377_300n);
      const [ev] = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.purchase_order_id = ${poId} AND e.event_type = 'ORDERED'`;
      expect(ev.n).toBe(2);

      // sửa tỷ giá theo sao kê → giá vốn đổi theo; mốc Đã đặt theo ngày đặt mới
      await svc.savePurchaseOrder(tx, b.id, poId, po({ fxRate: "26400", orderedAt: "2026-10-30" }));
      expect((await svc.getBatch(tx, b.id))!.summary.totalLandedCostVnd).toBe(47_467_200n);

      // sửa 1 máy, xoá 1 máy, thêm 1 máy
      const [iphone] = order.items;
      const r2 = await svc.saveItems(tx, poId, [
        row({ id: iphone.id, variantId: IPHONE, unitPrice: "1,099.00", serial: "F2LXQ7Y9ZZ", imei1: IMEI_A, partNumber: "MDEM1LL/A" }),
        row({ variantId: IPHONE, unitPrice: "1099", imei1: IMEI_B, condition: "Mở hộp" }),
      ]);
      expect(r2).toMatchObject({ inserted: 1, updated: 1, deleted: 1 });
      const after = (await svc.getBatch(tx, b.id))!.orders[0].items;
      expect(after.map((i) => [i.imei1, i.unitPrice, i.condition])).toEqual([
        [IMEI_A, "1099.00", "NEW_SEALED"],
        [IMEI_B, "1099.00", "OPEN_BOX"],
      ]);
      // subtotal 1.798 ≠ Σ đơn giá 2.198 → cảnh báo vàng từ bộ tính giá vốn
      expect(r2.recalc.warnings).toEqual([expect.objectContaining({ code: "PO_SUBTOTAL_MISMATCH" })]);
      // lưu lại y nguyên → không đổi gì
      expect(
        await svc.saveItems(
          tx,
          poId,
          after.map((i) =>
            row({
              id: i.id,
              variantId: i.variantId,
              unitPrice: i.unitPrice,
              serial: i.serial ?? "",
              imei1: i.imei1 ?? "",
              partNumber: i.partNumber ?? "",
              condition: i.condition,
            }),
          ),
        ),
      ).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });

      await expect(svc.deletePurchaseOrder(tx, poId)).rejects.toMatchObject({ code: "IN_USE" });
      await expect(svc.deleteBatch(tx, b.id)).rejects.toMatchObject({ code: "IN_USE", message: expect.stringContaining("còn 1 đơn mua") });
      await svc.saveItems(tx, poId, []);
      await svc.deletePurchaseOrder(tx, poId);
      expect((await svc.getBatch(tx, b.id))!.orders).toEqual([]);
      // chuyến từng có đơn → xoá mềm: biến mất khỏi danh sách, dữ liệu cũ vẫn còn
      await svc.deleteBatch(tx, b.id);
      expect(await svc.getBatch(tx, b.id)).toBeNull();
      expect((await svc.listBatches(tx)).some((x) => x.id === b.id)).toBe(false);
      const [kept] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM items WHERE batch_id = ${b.id}`;
      expect(kept.n).toBe(3); // 2 máy ban đầu + 1 máy thêm sau (cả máy đã xoá mềm)
    });
  });

  it("lưới: lỗi theo từng ô (thiếu cấu hình, IMEI sai, trùng trong lưới, trùng máy đã có ở chuyến khác) → không ghi gì", async () => {
    await inTx(async (tx) => {
      const b = await svc.createBatch(tx, { code: "CH-TEST-501", name: null, plannedFxRate: null, note: null });
      const { id: poId } = await svc.savePurchaseOrder(tx, b.id, null, po());
      const err = await svc
        .saveItems(tx, poId, [
          row({ unitPrice: "100" }),
          row({ variantId: IPHONE, unitPrice: "100", imei1: "356938035643808" }),
          row({ variantId: IPHONE, unitPrice: "100", serial: "SERIALIPHONE01" }), // đã có ở CH-2026-011
          row({ variantId: IPHONE, unitPrice: "100", imei1: IMEI_B }),
          row({ variantId: IPHONE, unitPrice: "100", imei2: IMEI_B }),
        ])
        .catch((e) => e);
      expect(err).toMatchObject({ code: "INVALID_ROWS" });
      expect(err.rowIssues.map((i: { row: number; field: string; message: string }) => [i.row, i.field, i.message])).toEqual([
        [0, "variantId", "Chọn cấu hình máy"],
        [1, "imei1", "IMEI sai (phải đủ 15 số, đúng số kiểm tra)"],
        [4, "imei2", "Trùng với dòng 4"],
        [2, "serial", "SERIALIPHONE01 đã có ở một máy khác (chuyến CH-2026-011) — quét lại hay nhầm hàng?"],
      ]);
      const [n] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM items WHERE purchase_order_id = ${poId}`;
      expect(n.n).toBe(0);
    });
  });

  it("chuyến đã chốt: sửa đơn giá / tỷ giá bị chặn BATCH_FINALIZED; máy đã vào kiện không xoá khỏi đơn được", async () => {
    await inTx(async (tx) => {
      const order = (await svc.getBatch(tx, CH011))!.orders[0];
      expect(order.items.every((i) => i.locked)).toBe(true);
      const asRows = order.items.map((i) =>
        row({ id: i.id, variantId: i.variantId, unitPrice: i.unitPrice, serial: i.serial ?? "", imei1: i.imei1 ?? "", partNumber: i.partNumber ?? "" }),
      );
      // lưu y nguyên trên chuyến đã chốt → được (không đổi giá vốn)
      await expect(svc.saveItems(tx, PO011, asRows)).resolves.toMatchObject({ updated: 0 });
      // ghi chú không ảnh hưởng giá vốn → được
      await expect(
        svc.saveItems(
          tx,
          PO011,
          asRows.map((r, k) => (k === 2 ? { ...r, note: "hộp móp" } : r)),
        ),
      ).resolves.toMatchObject({ updated: 1 });
      await expect(
        svc.saveItems(
          tx,
          PO011,
          asRows.map((r, k) => (k === 0 ? { ...r, unitPrice: "1149" } : r)),
        ),
      ).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
      await expect(svc.savePurchaseOrder(tx, CH011, PO011, po({ subtotal: "2047", fxRate: "26500" }))).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
      const err = await svc.saveItems(tx, PO011, asRows.slice(0, 2)).catch((e) => e);
      expect(err.rowIssues[0].message).toContain("SERIALAIRPODS1 đã vào kiện hoặc đã bán");
      // mở lại chuyến → sửa tỷ giá được, giá vốn tính lại
      await reopenBatchCosts(tx, CH011, "Sao kê thẻ tỷ giá khác");
      const { recalc } = await svc.savePurchaseOrder(
        tx,
        CH011,
        PO011,
        po({ subtotal: "2047", fxRate: "26500", orderNumber: "W123456789", orderedAt: "2026-10-01" }),
      );
      expect(recalc.batches[0]).toMatchObject({ beforeVnd: 55_943_208n, afterVnd: 56_147_908n }); // +2.047 × 100
    });
  });

  it("danh sách cấu hình cho lưới: kèm mã Part No. và cân nặng", async () => {
    const refs = await svc.variantRefs(sql);
    expect(refs.find((v) => v.id === IPHONE)).toEqual({
      id: IPHONE,
      label: "iPhone Pro Max · 256GB · Silver",
      sku: "IPPM-256-SLV",
      codes: ["MDEM1LL/A"],
      defaultWeightKg: "0.600",
    });
    const opts = await svc.purchaseOptions(sql);
    expect(opts.suppliers).toEqual([{ id: SUPPLIER, name: "Apple Store", return_days: 14 }]);
  });
});
