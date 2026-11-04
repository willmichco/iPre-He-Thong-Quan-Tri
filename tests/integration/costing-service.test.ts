/**
 * Kiểm thử tích hợp dịch vụ giá vốn với PostgreSQL thật (đã migrate + nạp db/seed-vi-du.sql).
 * Mỗi ca chạy trong một transaction rồi HUỶ — dữ liệu ví dụ không bị đổi.
 *
 *   DATABASE_URL=… npm run db:seed && npm run test:db
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { checkAllBatches, finalizeBatchCosts, recalculateBatch, recalculateBatches, recalculateSale, reopenBatchCosts } from "@/server/costing/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

// ---- Dữ liệu ví dụ (db/seed-vi-du.sql) -------------------------------------------------------------------
const CH011 = "60000000-0000-0000-0000-000000000001";
const IPHONE = "80000000-0000-0000-0000-000000000001";
const IPAD = "80000000-0000-0000-0000-000000000002";
const AIRPODS = "80000000-0000-0000-0000-000000000003";
const COST_INTL = "a0000000-0000-0000-0000-000000000002";
const SHIP_HNSG = "90000000-0000-0000-0000-000000000003";
const VARIANT_IPHONE = "20000000-0000-0000-0000-000000000001";
const MODEL_IPHONE = "10000000-0000-0000-0000-000000000001";
const SUPPLIER = "30000000-0000-0000-0000-000000000001";

// ---- Chuyến nháp tự tạo trong transaction ----------------------------------------------------------------
const B2 = "61000000-0000-0000-0000-000000000002";
const PO2 = "71000000-0000-0000-0000-000000000002";
const X1 = "81000000-0000-0000-0000-000000000001";
const X2 = "81000000-0000-0000-0000-000000000002";

class Rollback extends Error {}
/** Chạy `fn` trong transaction rồi huỷ toàn bộ. */
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

async function landed(tx: TransactionSql, itemId: string): Promise<bigint> {
  const [r] = await tx<{ v: string }[]>`SELECT landed_cost_vnd::text AS v FROM v_item_landed_cost WHERE item_id = ${itemId}`;
  return BigInt(r.v);
}
async function alloc(tx: TransactionSql, itemId: string, component: string): Promise<bigint> {
  const [r] = await tx<{ v: string }[]>`
    SELECT COALESCE(SUM(amount_vnd), 0)::text AS v FROM item_cost_allocations WHERE item_id = ${itemId} AND component = ${component}`;
  return BigInt(r.v);
}
async function summary(tx: TransactionSql, batchId = CH011) {
  const [r] = await tx<{ s: string }[]>`
    SELECT total_landed_cost_vnd||'|'||realized_profit_vnd||'|'||coalesce(roi_on_sold_pct::text,'') AS s FROM v_batch_summary WHERE batch_id = ${batchId}`;
  return r.s;
}

/** Chuyến nháp B2: 1 đơn mua 1.000 + 500 USD × 25.000, tax 120 USD, giảm giá 30 USD. */
async function draftBatch(tx: TransactionSql) {
  await tx`INSERT INTO batches (id, code, status) VALUES (${B2}, 'CH-TEST-002', 'PURCHASING')`;
  await tx`
    INSERT INTO purchase_orders (id, batch_id, supplier_id, ordered_at, subtotal, sales_tax, discount, fx_rate)
    VALUES (${PO2}, ${B2}, ${SUPPLIER}, now(), 1500, 120, 30, 25000)`;
  await tx`
    INSERT INTO items (id, batch_id, purchase_order_id, variant_id, unit_price, status) VALUES
      (${X1}, ${B2}, ${PO2}, ${VARIANT_IPHONE}, 1000, 'AT_US_WAREHOUSE'),
      (${X2}, ${B2}, ${PO2}, ${VARIANT_IPHONE}, 500,  'AT_US_WAREHOUSE')`;
}

describe("dịch vụ giá vốn ↔ PostgreSQL", () => {
  it("bộ máy tính từ CSDL ra ĐÚNG từng dòng phân bổ đã ghi trong dữ liệu ví dụ (khớp 0 đồng)", async () => {
    await inTx(async (tx) => {
      const r = await recalculateBatch(tx, CH011, { dryRun: true });
      expect(r.batches).toEqual([
        expect.objectContaining({ code: "CH-2026-011", inserted: 0, updated: 0, deleted: 0, beforeVnd: 55_943_208n, afterVnd: 55_943_208n }),
      ]);
      expect(r.allocationCount).toBe(15);
      expect(r.warnings).toEqual([]);
      // tính lại thật trên chuyến ĐÃ CHỐT: không đổi gì nên được phép, số liệu báo cáo giữ nguyên
      await recalculateBatch(tx, CH011);
      expect(await summary(tx)).toBe("55943208|2706128|5.53");
      // mọi chuyến trong CSDL (kể cả dữ liệu do lần chạy khác để lại) đều phải khớp bộ máy
      const all = await checkAllBatches(tx);
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.flatMap((r) => r.batches).every((b) => b.inserted + b.updated + b.deleted === 0)).toBe(true);
    });
  });

  it("chuyến đã chốt: thao tác làm đổi giá vốn bị chặn BATCH_FINALIZED, huỷ cả thao tác sửa dữ liệu", async () => {
    await inTx(async (tx) => {
      await expect(
        tx.begin(async (t) => {
          await t`UPDATE costs SET amount = 700000 WHERE id = ${COST_INTL}`;
          await recalculateBatch(t, CH011);
        }),
      ).rejects.toMatchObject({ code: "BATCH_FINALIZED", refs: [CH011] });
      const [c] = await tx<{ v: string }[]>`SELECT amount_vnd::text AS v FROM costs WHERE id = ${COST_INTL}`;
      expect(c.v).toBe("684000");
      expect(await summary(tx)).toBe("55943208|2706128|5.53");
    });
  });

  it("mở lại (bắt buộc lý do, ghi nhật ký) → sửa cước → giá vốn & lãi tự cập nhật → chốt lại", async () => {
    await inTx(async (tx) => {
      await expect(reopenBatchCosts(tx, CH011, "  ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
      await reopenBatchCosts(tx, CH011, "Forwarder gửi hoá đơn cước điều chỉnh", { ip: "127.0.0.1", userAgent: "vitest" });
      const [b] = await tx<{ status: string; f: string | null }[]>`SELECT status::text, costs_finalized_at::text AS f FROM batches WHERE id = ${CH011}`;
      expect(b).toEqual({ status: "ARRIVED", f: null });

      // cước Mỹ→VN 684.000 → 702.000 (+18.000), theo cân nặng 0,6 / 0,9 / 0,3 kg
      await tx`UPDATE costs SET amount = 702000 WHERE id = ${COST_INTL}`;
      const r = await recalculateBatch(tx, CH011);
      expect(r.batches[0]).toMatchObject({ updated: 3, inserted: 0, deleted: 0, beforeVnd: 55_943_208n, afterVnd: 55_961_208n });
      expect([await alloc(tx, IPHONE, "INTL_SHIPPING"), await alloc(tx, IPAD, "INTL_SHIPPING"), await alloc(tx, AIRPODS, "INTL_SHIPPING")]).toEqual([
        234_000n,
        351_000n,
        117_000n,
      ]);
      // lãi chuyến giảm đúng phần cước tăng của 2 máy đã bán (6.000 + 9.000); vốn đọng tăng 3.000
      expect(await summary(tx)).toBe("55961208|2691128|5.49");

      const fin = await finalizeBatchCosts(tx, CH011);
      expect(fin.summary).toMatchObject({ totalLandedCostVnd: "55961208", realizedProfitVnd: "2691128", unsoldCostVnd: "6982336" });
      const logs = await tx<{ action: string; reason: string | null }[]>`
        SELECT action, after->>'reason' AS reason FROM audit_logs WHERE entity_id = ${CH011} AND occurred_at = now() ORDER BY id`;
      expect(logs).toEqual([
        { action: "REOPEN", reason: "Forwarder gửi hoá đơn cước điều chỉnh" },
        { action: "FINALIZE", reason: null },
      ]);
      await expect(finalizeBatchCosts(tx, CH011)).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
    });
  });

  it("không chốt được khi còn máy chưa về SG hoặc còn chi phí dự toán", async () => {
    await inTx(async (tx) => {
      await expect(reopenBatchCosts(tx, B2, "chưa có chuyến")).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
      await draftBatch(tx);
      await expect(reopenBatchCosts(tx, B2, "chuyến chưa chốt")).rejects.toMatchObject({ code: "BATCH_NOT_READY" });
      await tx`
        INSERT INTO costs (id, kind, batch_id, amount, allocation_method, is_estimate, incurred_at)
        VALUES ('a1000000-0000-0000-0000-000000000001', 'HANDLING', ${B2}, 100000, 'BY_QUANTITY', true, now())`;
      await expect(finalizeBatchCosts(tx, B2)).rejects.toMatchObject({
        code: "BATCH_NOT_READY",
        message: expect.stringMatching(/2 máy chưa về SG.*1 khoản chi phí còn là dự toán/),
      });
      await tx`UPDATE items SET status = 'IN_STOCK' WHERE batch_id = ${B2}`;
      await tx`INSERT INTO item_events (item_id, event_type, occurred_at) SELECT id, 'SG_RECEIVED', now() FROM items WHERE batch_id = ${B2}`;
      await tx`UPDATE costs SET is_estimate = false WHERE batch_id = ${B2}`;
      await expect(finalizeBatchCosts(tx, B2)).resolves.toMatchObject({ code: "CH-TEST-002" });
    });
  });

  it("đơn mua: thuế, giảm giá theo tỷ giá của đơn; tổng giá vốn = total_vnd của đơn + chi phí", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      const r = await recalculateBatch(tx, B2);
      // (1500 + 120 − 30) × 25.000 = 39.750.000
      expect(r.batches[0]).toMatchObject({ inserted: 6, afterVnd: 39_750_000n });
      const [po] = await tx<{ v: string }[]>`SELECT total_vnd::text AS v FROM purchase_orders WHERE id = ${PO2}`;
      expect(po.v).toBe("39750000");
      expect([await alloc(tx, X1, "SALES_TAX"), await alloc(tx, X2, "SALES_TAX")]).toEqual([2_000_000n, 1_000_000n]);
      expect([await alloc(tx, X1, "DISCOUNT"), await alloc(tx, X2, "DISCOUNT")]).toEqual([-500_000n, -250_000n]);
      // tỷ giá thực tế đổi (sao kê về) → tự tính lại
      await tx`UPDATE purchase_orders SET fx_rate = 25350.5 WHERE id = ${PO2}`;
      const r2 = await recalculateBatch(tx, B2);
      expect(r2.batches[0]).toMatchObject({ updated: 6, afterVnd: 40_307_295n });
      const [po2] = await tx<{ v: string }[]>`SELECT total_vnd::text AS v FROM purchase_orders WHERE id = ${PO2}`;
      expect(po2.v).toBe("40307295");
      // subtotal lệch Σ đơn giá → cảnh báo vàng, không chặn
      await tx`UPDATE purchase_orders SET subtotal = 1600 WHERE id = ${PO2}`;
      expect((await recalculateBatch(tx, B2)).warnings).toEqual([expect.objectContaining({ code: "PO_SUBTOTAL_MISMATCH", refs: [PO2] })]);
    });
  });

  it("kiện gom máy của nhiều chuyến: tính cùng lúc mọi chuyến liên quan; chuyến kia đã chốt → chặn", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      // gom X1 vào kiện HN→SG của chuyến CH-2026-011 (đã chốt) → cước 150.000 chia 4 thay vì 3
      await expect(
        tx.begin(async (t) => {
          await t`INSERT INTO shipment_items (shipment_id, leg_type, item_id) VALUES (${SHIP_HNSG}, 'HN_TO_SG', ${X1})`;
          await recalculateBatch(t, B2);
        }),
      ).rejects.toMatchObject({ code: "BATCH_FINALIZED", refs: [CH011] });

      await reopenBatchCosts(tx, CH011, "Gom thêm máy chuyến khác vào kiện HN→SG");
      await tx`INSERT INTO shipment_items (shipment_id, leg_type, item_id) VALUES (${SHIP_HNSG}, 'HN_TO_SG', ${X1})`;
      const r = await recalculateBatch(tx, B2);
      expect(r.batches.map((b) => b.code).sort()).toEqual(["CH-2026-011", "CH-TEST-002"]);
      for (const id of [IPHONE, IPAD, AIRPODS, X1]) expect(await alloc(tx, id, "DOMESTIC_SHIPPING")).toBe(37_500n);
      const old = r.batches.find((b) => b.code === "CH-2026-011")!;
      expect(old.afterVnd - old.beforeVnd).toBe(-37_500n);
      // gọi từ phía chuyến cũ cũng kéo theo chuyến mới — kết quả như nhau
      expect((await recalculateBatch(tx, CH011)).batches.every((b) => b.inserted + b.updated + b.deleted === 0)).toBe(true);
    });
  });

  it("máy trả người bán: mặc định chi phí chung dồn cho máy còn lại; cài đặt WRITE_OFF → máy trả vẫn gánh (ghi lỗ)", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      await tx`
        INSERT INTO costs (id, kind, batch_id, amount, allocation_method, incurred_at)
        VALUES ('a1000000-0000-0000-0000-000000000002', 'US_DOMESTIC_SHIPPING', ${B2}, 90000, 'BY_QUANTITY', now())`;
      await tx`UPDATE items SET status = 'RETURNED_TO_SELLER' WHERE id = ${X2}`;
      await recalculateBatch(tx, B2);
      expect([await alloc(tx, X1, "US_DOMESTIC_SHIPPING"), await alloc(tx, X2, "US_DOMESTIC_SHIPPING")]).toEqual([90_000n, 0n]);
      await tx`INSERT INTO app_settings (key, value) VALUES ('costing.returned_item_policy', '"WRITE_OFF"')`;
      await recalculateBatch(tx, B2);
      expect([await alloc(tx, X1, "US_DOMESTIC_SHIPPING"), await alloc(tx, X2, "US_DOMESTIC_SHIPPING")]).toEqual([45_000n, 45_000n]);
    });
  });

  it("chi phí nhập tay (MANUAL) đọc từ cost_manual_shares; lệch tổng → lỗi rõ ràng, không ghi gì", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      const k = "a1000000-0000-0000-0000-000000000003";
      await tx`INSERT INTO costs (id, kind, purchase_order_id, amount, allocation_method, incurred_at) VALUES (${k}, 'HANDLING', ${PO2}, 100000, 'MANUAL', now())`;
      await tx`INSERT INTO cost_manual_shares (cost_id, item_id, amount_vnd) VALUES (${k}, ${X1}, 70000), (${k}, ${X2}, 20000)`;
      await expect(recalculateBatch(tx, B2)).rejects.toMatchObject({ code: "MANUAL_SHARES_MISMATCH" });
      expect(await alloc(tx, X1, "PRICE")).toBe(0n); // không ghi dở dang
      await tx`UPDATE cost_manual_shares SET amount_vnd = 30000 WHERE cost_id = ${k} AND item_id = ${X2}`;
      await recalculateBatch(tx, B2);
      expect([await alloc(tx, X1, "HANDLING"), await alloc(tx, X2, "HANDLING")]).toEqual([70_000n, 30_000n]);
    });
  });

  it("cân nặng: lấy của máy, thiếu thì lấy mặc định của cấu hình; thiếu cả hai → MISSING_WEIGHT chỉ đúng máy", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      const v = "21000000-0000-0000-0000-000000000009";
      await tx`INSERT INTO product_variants (id, model_id, sku) VALUES (${v}, ${MODEL_IPHONE}, 'TEST-NO-WEIGHT')`;
      await tx`UPDATE items SET variant_id = ${v} WHERE id = ${X2}`;
      await tx`
        INSERT INTO costs (id, kind, batch_id, amount, allocation_method, incurred_at)
        VALUES ('a1000000-0000-0000-0000-000000000004', 'INTL_SHIPPING', ${B2}, 300000, 'BY_WEIGHT', now())`;
      await expect(recalculateBatch(tx, B2)).rejects.toMatchObject({ code: "MISSING_WEIGHT", refs: ["a1000000-0000-0000-0000-000000000004", X2] });
      await tx`UPDATE items SET weight_kg = 1.2 WHERE id = ${X2}`; // X1 dùng mặc định 0,6 kg
      await recalculateBatch(tx, B2);
      expect([await alloc(tx, X1, "INTL_SHIPPING"), await alloc(tx, X2, "INTL_SHIPPING")]).toEqual([100_000n, 200_000n]);
    });
  });

  it("xoá mềm một máy: dọn dòng phân bổ cũ, giá trị đơn dồn lại cho máy còn lại", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      await recalculateBatch(tx, B2);
      await tx`UPDATE items SET deleted_at = now() WHERE id = ${X2}`;
      const r = await recalculateBatch(tx, B2);
      expect(r.batches[0]).toMatchObject({ deleted: 3, beforeVnd: 26_500_000n });
      // đơn vẫn ghi subtotal 1.500 USD trong khi chỉ còn máy 1.000 USD → cảnh báo vàng để sửa đơn
      expect(r.warnings).toEqual([expect.objectContaining({ code: "PO_SUBTOTAL_MISMATCH" })]);
      const [n] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM item_cost_allocations WHERE item_id = ${X2}`;
      expect(n.n).toBe(0);
      // cả thuế & giảm giá của đơn giờ nằm trên X1: (1.000 + 120 − 30) × 25.000
      expect(await landed(tx, X1)).toBe(27_250_000n);
    });
  });

  it("đơn bán: giảm giá & chi phí bán hàng chia theo giá bán từng dòng; dòng huỷ không gánh nữa", async () => {
    await inTx(async (tx) => {
      await draftBatch(tx);
      const s = "c1000000-0000-0000-0000-000000000001";
      await tx`INSERT INTO sales (id, code, sold_at, discount_vnd) VALUES (${s}, 'BH-TEST-1', now(), 300000)`;
      await tx`INSERT INTO sale_items (sale_id, item_id, price_vnd) VALUES (${s}, ${X1}, 10000000), (${s}, ${X2}, 5000000)`;
      await tx`INSERT INTO sale_expenses (sale_id, kind, amount_vnd) VALUES (${s}, 'SHIPPING_TO_CUSTOMER', 30000), (${s}, 'COD_FEE', 15000)`;
      await recalculateSale(tx, s);
      const rows = () =>
        tx<{ item: string; d: string; e: string }[]>`
          SELECT item_id::text AS item, discount_alloc_vnd::text AS d, expense_alloc_vnd::text AS e FROM sale_items WHERE sale_id = ${s} ORDER BY price_vnd DESC`;
      expect(await rows()).toEqual([
        { item: X1, d: "200000", e: "30000" },
        { item: X2, d: "100000", e: "15000" },
      ]);
      await tx`UPDATE sale_items SET voided_at = now(), void_reason = 'khách trả' WHERE item_id = ${X2}`;
      await recalculateSale(tx, s);
      expect(await rows()).toEqual([
        { item: X1, d: "300000", e: "45000" },
        { item: X2, d: "0", e: "0" },
      ]);
      await expect(recalculateSale(tx, "c1000000-0000-0000-0000-00000000ffff")).rejects.toMatchObject({ code: "SALE_NOT_FOUND" });
      // dữ liệu ví dụ: đơn 1 dòng, ship khách 30.000 → khớp số đã ghi
      expect(await recalculateSale(tx, "c0000000-0000-0000-0000-000000000001")).toEqual([
        expect.objectContaining({ discountAllocVnd: 0n, expenseAllocVnd: 30_000n }),
      ]);
    });
  });

  it("gọi với nhiều chuyến / chuyến không tồn tại", async () => {
    await inTx(async (tx) => {
      await expect(recalculateBatches(tx, ["69999999-0000-0000-0000-000000000000"])).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
      await draftBatch(tx);
      const r = await recalculateBatches(tx, [CH011, B2], { dryRun: true });
      expect(r.dryRun).toBe(true);
      expect(r.batches).toHaveLength(2);
      expect(await alloc(tx, X1, "PRICE")).toBe(0n); // dryRun không ghi
    });
  });
});
