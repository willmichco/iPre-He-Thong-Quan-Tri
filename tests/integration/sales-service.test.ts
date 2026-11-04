/**
 * Kiểm thử tích hợp bán hàng & hồ sơ máy với PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@/domain/catalog";
import { emptyRow, purchaseOrderSchema } from "@/domain/purchasing";
import { saleSchema } from "@/domain/sales";
import * as purchasing from "@/server/purchasing/service";
import * as svc from "@/server/sales/service";

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
const IPHONE = "80000000-0000-0000-0000-000000000001";
const AIRPODS = "80000000-0000-0000-0000-000000000003";
const BANK = "50000000-0000-0000-0000-000000000002";
const NOW = new Date("2026-11-04T03:00:00Z"); // 10:00 giờ VN

function sale(over: Record<string, unknown>) {
  const r = validate(saleSchema, { lines: [{ itemId: AIRPODS, price: "7,5tr" }], accountId: BANK, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
const summary = async (tx: TransactionSql) =>
  (await tx<{ s: string }[]>`SELECT sold_count||'|'||realized_profit_vnd||'|'||unsold_cost_vnd AS s FROM v_batch_summary WHERE batch_id = ${CH011}`)[0].s;
const status = async (tx: TransactionSql, id: string) => (await tx<{ s: string }[]>`SELECT status::text AS s FROM items WHERE id = ${id}`)[0].s;

/** Máy mới đang ở kho Mỹ (chưa về SG). */
async function pending(tx: TransactionSql) {
  const b = await purchasing.createBatch(tx, { code: "CH-TEST-900", name: null, plannedFxRate: null, note: null });
  const po = validate(purchaseOrderSchema, { supplierId: "30000000-0000-0000-0000-000000000001", orderedAt: "2026-10-25", subtotal: "1000", fxRate: "25000" });
  if (!po.ok) throw new Error("po");
  const { id } = await purchasing.savePurchaseOrder(tx, b.id, null, po.data);
  await purchasing.saveItems(tx, id, [{ ...emptyRow(), variantId: "20000000-0000-0000-0000-000000000001", unitPrice: "1000", imei1: "356938035643809" }]);
  const [it] = await tx<{ id: string }[]>`UPDATE items SET status = 'AT_US_WAREHOUSE' WHERE imei1 = '356938035643809' RETURNING id::text`;
  await tx`INSERT INTO item_events (item_id, event_type, occurred_at) VALUES (${it.id}, 'SELLER_SHIPPED', now()), (${it.id}, 'US_WAREHOUSE_RECEIVED', now())`;
  return it.id;
}

describe("Bán hàng ↔ PostgreSQL", () => {
  it("tra máy: giá vốn hiện tại, bán được hay không và vì sao", async () => {
    expect(await svc.findItemForSale(sql, " serialairpods1 ")).toMatchObject({
      id: AIRPODS,
      label: "AirPods Pro · White",
      costVnd: 6_979_336n,
      sellable: "NOW",
      arrivedSg: true,
      activeSale: null,
    });
    expect(await svc.findItemForSale(sql, "350000000000006")).toMatchObject({ sellable: "NO", reason: "Đã bán ở đơn BH-2026-0001" });
    expect(await svc.findItemForSale(sql, "KHONGCO")).toBeNull();
  });

  it("bán nhanh hoàn tất: mã đơn tự cấp, máy Đã bán + mốc M8 + bảo hành 6 tháng, thu tiền vào sổ, lãi chuyến cập nhật", async () => {
    await inTx(async (tx) => {
      const r = await svc.createSale(tx, sale({ customerPhone: "0912 345 678", customerName: "Anh Long", channel: "ZALO", shippingFee: "30k" }), NOW);
      expect(r).toMatchObject({ code: "BH-2026-0003", status: "COMPLETED" });
      expect(await status(tx, AIRPODS)).toBe("SOLD");
      const d = (await svc.getSale(tx, r.id))!;
      expect(d).toMatchObject({ customer: { name: "Anh Long", phone: "0912345678" }, totalVnd: 7_500_000n, paidVnd: 7_500_000n, balanceVnd: 0n });
      expect(d.lines[0]).toMatchObject({ costSnapshotVnd: 6_979_336n, expenseAllocVnd: 30_000n, warrantyUntil: "2027-05-04" });
      expect(d.payments).toEqual([expect.objectContaining({ direction: "IN", amountVnd: 7_500_000n, category: "SALE_RECEIPT", account: "Ngân hàng chính" })]);
      // lãi: 7.500.000 − 6.979.336 − 30.000 = 490.664 → lãi chuyến 2.706.128 + 490.664; hết vốn đọng
      expect(await summary(tx)).toBe("3|3196792|0");
      const list = await svc.listSales(tx);
      expect(list[0]).toMatchObject({ code: "BH-2026-0003", profitVnd: 490_664n, balanceVnd: 0n, customer: "Anh Long" });
      // khách quen: cùng SĐT → không tạo khách mới
      await expect(svc.createSale(tx, sale({}), NOW)).rejects.toMatchObject({ code: "NOT_SELLABLE" });
      const [n] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM customers WHERE phone = '0912345678'`;
      expect(n.n).toBe(1);
    });
  });

  it("bán dưới giá vốn cần xác nhận; trả thiếu = công nợ; thu thêm sau", async () => {
    await inTx(async (tx) => {
      await expect(svc.createSale(tx, sale({ lines: [{ itemId: AIRPODS, price: "6tr" }] }), NOW)).rejects.toMatchObject({
        code: "NEEDS_CONFIRM",
        field: "confirmBelowCost",
      });
      const r = await svc.createSale(tx, sale({ lines: [{ itemId: AIRPODS, price: "6tr" }], confirmBelowCost: "on", paidAmount: "5tr" }), NOW);
      expect((await svc.getSale(tx, r.id))!.balanceVnd).toBe(1_000_000n);
      await expect(svc.addPayment(tx, r.id, BANK, 2_000_000n)).rejects.toMatchObject({ field: "amount" });
      await svc.addPayment(tx, r.id, BANK, 1_000_000n);
      expect((await svc.getSale(tx, r.id))!.balanceVnd).toBe(0n);
      expect((await svc.listSales(tx))[0].profitVnd).toBe(-979_336n);
    });
  });

  it("đặt cọc khi máy còn ở Mỹ → hoàn tất khi về (hoặc bán giao thẳng); máy giữ 'Khách cọc' suốt đường về", async () => {
    await inTx(async (tx) => {
      const itemId = await pending(tx);
      expect((await svc.findItemForSale(tx, "356938035643809"))!.sellable).toBe("DEPOSIT_ONLY");
      await expect(svc.createSale(tx, sale({ lines: [{ itemId, price: "28tr" }] }), NOW)).rejects.toMatchObject({ code: "NEEDS_CONFIRM", field: "directShip" });
      const r = await svc.createSale(tx, sale({ lines: [{ itemId, price: "28tr" }], payment: "DEPOSIT", paidAmount: "2tr", customerPhone: "0987654321" }), NOW);
      expect(r.status).toBe("DEPOSITED");
      expect(await status(tx, itemId)).toBe("RESERVED");
      const d = (await svc.getSale(tx, r.id))!;
      expect(d).toMatchObject({ paidVnd: 2_000_000n, balanceVnd: 26_000_000n });
      expect(d.payments[0].category).toBe("SALE_DEPOSIT");
      expect((await svc.findItemForSale(tx, "356938035643809"))!.reason).toContain("Khách đã cọc ở đơn");

      await expect(svc.completeSale(tx, r.id)).rejects.toMatchObject({ code: "NEEDS_CONFIRM" });
      await svc.completeSale(tx, r.id, { directShip: true, warrantyMonths: 12, accountId: BANK, paidAmount: 26_000_000n }, NOW);
      const done = (await svc.getSale(tx, r.id))!;
      expect(done).toMatchObject({ status: "COMPLETED", balanceVnd: 0n });
      expect(done.lines[0]).toMatchObject({ warrantyUntil: "2027-11-04", costSnapshotVnd: 25_000_000n });
      expect(await status(tx, itemId)).toBe("SOLD");
      await expect(svc.completeSale(tx, r.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  it("huỷ cọc: máy về đúng trạng thái theo mốc, hoàn cọc ghi sổ chi; khách trả lại máy đã bán → về tồn kho", async () => {
    await inTx(async (tx) => {
      const itemId = await pending(tx);
      const r = await svc.createSale(tx, sale({ lines: [{ itemId, price: "28tr" }], payment: "DEPOSIT", paidAmount: "2tr", customerName: "Chị Mai" }), NOW);
      await expect(svc.cancelDeposit(tx, r.id, "đổi ý", 3_000_000n, BANK)).rejects.toMatchObject({ field: "refund" });
      await svc.cancelDeposit(tx, r.id, "Khách đổi ý", 1_500_000n, BANK); // giữ lại 500.000 tiền cọc
      expect(await status(tx, itemId)).toBe("AT_US_WAREHOUSE");
      const d = (await svc.getSale(tx, r.id))!;
      expect(d).toMatchObject({ status: "CANCELLED", paidVnd: 500_000n, balanceVnd: 0n });
      expect(d.lines[0].voidReason).toBe("Khách đổi ý");
      expect((await svc.findItemForSale(tx, "356938035643809"))!.sellable).toBe("DEPOSIT_ONLY");

      // khách trả lại máy đã bán trong dữ liệu ví dụ (iPhone, BH-2026-0001)
      const [line] = await tx<{ id: string }[]>`SELECT id::text FROM sale_items WHERE item_id = ${IPHONE}`;
      await svc.returnItem(tx, line.id, "Lỗi loa", 34_500_000n, BANK);
      expect(await status(tx, IPHONE)).toBe("IN_STOCK");
      // lãi chuyến chỉ còn iPad; vốn đọng có thêm iPhone
      expect(await summary(tx)).toBe("1|660264|39403472");
      expect((await svc.findItemForSale(tx, "SERIALIPHONE01"))!.sellable).toBe("NOW");
    });
  });

  it("hồ sơ máy: mốc M1–M8, thành phần giá vốn cộng đúng, lịch sử bán", async () => {
    const p = (await svc.getItemProfile(sql, IPHONE))!;
    expect(p).toMatchObject({ label: "iPhone Pro Max · 256GB · Silver", batch: { code: "CH-2026-011" }, supplier: "Apple Store", landedCostVnd: 32_424_136n });
    expect(p.events.map((e) => e.type)).toEqual([
      "ORDERED",
      "SELLER_SHIPPED",
      "US_WAREHOUSE_RECEIVED",
      "INTL_DEPARTED",
      "HN_ARRIVED",
      "DOMESTIC_DEPARTED",
      "SG_RECEIVED",
      "SOLD",
    ]);
    expect(p.components.map((c) => c.component)).toEqual(["PRICE", "US_DOMESTIC_SHIPPING", "INTL_SHIPPING", "INSURANCE", "DOMESTIC_SHIPPING"]);
    expect(p.sales).toEqual([expect.objectContaining({ code: "BH-2026-0001", priceVnd: 34_500_000n, profitVnd: 2_045_864n, warranty: "2027-04-23" })]);
    expect((await svc.searchItems(sql, "")).map((x) => x.serial_number)).toEqual(["SERIALAIRPODS1"]);
    expect((await svc.searchItems(sql, "phone01")).map((x) => x.id)).toEqual([IPHONE]);
  });
});
