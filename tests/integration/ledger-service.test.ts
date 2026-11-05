/**
 * Sổ quỹ ↔ PostgreSQL thật (đã nạp db/seed-vi-du.sql). Mỗi ca chạy trong transaction rồi HUỶ.
 * Dữ liệu ví dụ: thẻ Visa trả đơn mua 54.040.800 đ + cước nội địa Mỹ 528.000 đ; ngân hàng nhận 51.700.000 đ tiền bán,
 * trả 1.374.408 đ cước / bảo hiểm / chành, 30.000 đ ship cho khách, 500.000 đ quảng cáo.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@/domain/catalog";
import { costSchema } from "@/domain/costs";
import type { ManualEntryInput } from "@/domain/ledger";
import { purchaseOrderSchema } from "@/domain/purchasing";
import { reopenBatchCosts } from "@/server/costing/service";
import { deleteCost, saveCost } from "@/server/costs/service";
import * as svc from "@/server/ledger/service";
import { createBatch, deletePurchaseOrder, savePurchaseOrder } from "@/server/purchasing/service";

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

const VISA = "50000000-0000-0000-0000-000000000001";
const BANK = "50000000-0000-0000-0000-000000000002";
const CH011 = "60000000-0000-0000-0000-000000000001";
const PO011 = "70000000-0000-0000-0000-000000000001";
const SUPPLIER = "30000000-0000-0000-0000-000000000001";
const SHIP_INTL = "90000000-0000-0000-0000-000000000002";
const SALE1 = "c0000000-0000-0000-0000-000000000001";

const bal = async (tx: TransactionSql, id: string) => (await svc.listAccountBalances(tx)).find((a) => a.id === id)!.balanceCents;
const linked = (tx: TransactionSql, col: "cost_id" | "purchase_order_id" | "sale_expense_id", id: string) =>
  tx<{ direction: string; amount: string; amount_vnd: string; category_code: string; account_id: string; d: string }[]>`
    SELECT direction::text, amount::text, amount_vnd::text, category_code, account_id::text,
           to_char(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d
      FROM cash_transactions WHERE ${tx(col)} = ${id} AND deleted_at IS NULL`;
function cost(over: Record<string, string>) {
  const r = validate(costSchema, { kind: "HANDLING", target: `SHIPMENT:${SHIP_INTL}`, amount: "90.000", incurredAt: "2026-10-21", ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
function po(over: Record<string, string> = {}) {
  const r = validate(purchaseOrderSchema, { supplierId: SUPPLIER, orderedAt: "2026-11-01", subtotal: "1000", fxRate: "26.400", ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
const entry = (over: Partial<ManualEntryInput> = {}): ManualEntryInput => ({
  accountId: BANK,
  categoryCode: "OPEX_ADS",
  amount: "2tr",
  fxRate: null,
  occurredAt: "2026-11-03",
  counterparty: "Facebook",
  note: null,
  ...over,
});

describe("Sổ quỹ ↔ PostgreSQL", () => {
  it("dữ liệu ví dụ: mỗi chứng từ đã trả có đúng 1 bút toán, số dư đúng; ghi bổ sung chạy lại không sinh thêm", async () => {
    await inTx(async (tx) => {
      expect(await bal(tx, VISA)).toBe(-5_456_880_000n); // −54.568.800 đ
      expect(await bal(tx, BANK)).toBe(4_979_559_200n); // 49.795.592 đ
      expect(await linked(tx, "purchase_order_id", PO011)).toMatchObject([{ direction: "OUT", amount_vnd: "54040800", category_code: "PURCHASE" }]);
      const [{ n }] = await tx<{ n: number }[]>`SELECT ledger_backfill() AS n`;
      expect(n).toBe(0);
      const [{ missing }] = await tx<{ missing: number }[]>`
        SELECT COUNT(*)::int AS missing FROM costs c
         WHERE c.paid_at IS NOT NULL AND c.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.cost_id = c.id AND t.deleted_at IS NULL)`;
      expect(missing).toBe(0);
    });
  });

  it("chi phí theo chặng: đã trả → bút toán; sửa số tiền / bỏ ngày trả / hoàn phí / xoá → sổ quỹ đi theo", async () => {
    await inTx(async (tx) => {
      await reopenBatchCosts(tx, CH011, "kiểm thử sổ quỹ");
      const before = await bal(tx, BANK);
      const { id } = await saveCost(tx, null, cost({ accountId: BANK, paidAt: "2026-10-22" }));
      expect(await linked(tx, "cost_id", id)).toEqual([
        { direction: "OUT", amount: "90000.00", amount_vnd: "90000", category_code: "LANDED_COST", account_id: BANK, d: "2026-10-22" },
      ]);
      expect(await bal(tx, BANK)).toBe(before - 9_000_000n);

      await saveCost(tx, id, cost({ amount: "120.000", accountId: BANK, paidAt: "2026-10-23" }));
      expect(await linked(tx, "cost_id", id)).toMatchObject([{ amount_vnd: "120000", d: "2026-10-23" }]);

      await saveCost(tx, id, cost({ amount: "120.000" })); // chưa trả → thành công nợ, bút toán bị gỡ
      expect(await linked(tx, "cost_id", id)).toEqual([]);
      const debts = await svc.getDebts(tx);
      expect(debts.payables.find((p) => p.id === id)).toMatchObject({ kind: "COST", amountVnd: 120_000n, party: "Forwarder A" });

      await svc.markPaid(tx, { kind: "COST", id, accountId: BANK, paidAt: "2026-10-25" });
      expect(await linked(tx, "cost_id", id)).toMatchObject([{ amount_vnd: "120000", d: "2026-10-25" }]);
      expect((await svc.getDebts(tx)).payables.find((p) => p.id === id)).toBeUndefined();

      // hoàn phí (số âm) → bút toán THU
      const { id: refund } = await saveCost(tx, null, cost({ amount: "-50.000", accountId: BANK, paidAt: "2026-10-26" }));
      expect(await linked(tx, "cost_id", refund)).toMatchObject([{ direction: "IN", amount_vnd: "50000", category_code: "LANDED_COST_REFUND" }]);

      // chi phí USD trả từ thẻ VND → số tiền trong sổ là VND đã quy đổi
      const { id: usd } = await saveCost(tx, null, cost({ currency: "USD", amount: "15", fxRate: "26.400", accountId: VISA, paidAt: "2026-10-22" }));
      expect(await linked(tx, "cost_id", usd)).toMatchObject([{ amount: "396000.00", amount_vnd: "396000" }]);

      await deleteCost(tx, id);
      expect(await linked(tx, "cost_id", id)).toEqual([]);
      expect(await bal(tx, BANK)).toBe(before + 5_000_000n);
    });
  });

  it("đơn mua: thanh toán → bút toán; chưa trả → phải trả; xoá đơn → gỡ bút toán; đơn VND không trả từ TK USD", async () => {
    await inTx(async (tx) => {
      const b = await createBatch(tx, { code: "CH-TEST-SQ1", name: null, plannedFxRate: null, note: null });
      const { id } = await savePurchaseOrder(tx, b.id, null, po({ paymentAccountId: VISA, paidAt: "2026-11-01", salesTax: "80" }));
      expect(await linked(tx, "purchase_order_id", id)).toEqual([
        { direction: "OUT", amount: "28512000.00", amount_vnd: "28512000", category_code: "PURCHASE", account_id: VISA, d: "2026-11-01" },
      ]);
      await savePurchaseOrder(tx, b.id, id, po({ orderNumber: "A-1" }));
      expect(await linked(tx, "purchase_order_id", id)).toEqual([]);
      expect((await svc.getDebts(tx)).payables.find((p) => p.id === id)).toMatchObject({
        kind: "PURCHASE_ORDER",
        amountVnd: 26_400_000n,
        party: "Apple Store",
      });

      const [{ id: usdAcc }] = await tx<{ id: string }[]>`INSERT INTO accounts (name, currency, kind) VALUES ('Thẻ USD thử', 'USD', 'CARD') RETURNING id::text`;
      await savePurchaseOrder(tx, b.id, id, po({ paymentAccountId: usdAcc, paidAt: "2026-11-02" }));
      expect(await linked(tx, "purchase_order_id", id)).toMatchObject([{ amount: "1000.00", amount_vnd: "26400000", account_id: usdAcc }]);
      await expect(
        savePurchaseOrder(tx, b.id, id, po({ currency: "VND", fxRate: "1", subtotal: "1000000", paymentAccountId: usdAcc, paidAt: "2026-11-02" })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", field: "paymentAccountId" });

      await deletePurchaseOrder(tx, id);
      expect(await linked(tx, "purchase_order_id", id)).toEqual([]);
    });
  });

  it("nhập tay: ghi / sửa / xoá; không chọn danh mục tự sinh; bút toán tự sinh chỉ sửa ở chứng từ gốc", async () => {
    await inTx(async (tx) => {
      const before = await bal(tx, BANK);
      const id = await svc.saveManualEntry(tx, null, entry());
      expect(await bal(tx, BANK)).toBe(before - 200_000_000n);
      const t = (await svc.getTransaction(tx, id))!;
      expect(t).toMatchObject({ source: "MANUAL", amountVnd: 2_000_000n, category: "Quảng cáo", isOperating: true, date: "2026-11-03", link: null });

      await svc.saveManualEntry(tx, id, entry({ amount: "2.500.000", categoryCode: "CAPITAL_IN", note: "Góp thêm" }));
      expect(await svc.getTransaction(tx, id)).toMatchObject({ direction: "IN", amountVnd: 2_500_000n, note: "Góp thêm" });
      expect(await bal(tx, BANK)).toBe(before + 250_000_000n);

      await expect(svc.saveManualEntry(tx, null, entry({ categoryCode: "PURCHASE" }))).rejects.toMatchObject({ field: "categoryCode" });
      await expect(svc.saveManualEntry(tx, null, entry({ amount: "abc" }))).rejects.toMatchObject({ field: "amount" });

      const auto = (await svc.listTransactions(tx, { category: "PURCHASE" })).rows[0];
      expect(auto).toMatchObject({ source: "PURCHASE_ORDER", link: { href: `/chuyen-hang/${CH011}` } });
      await expect(svc.saveManualEntry(tx, auto.id, entry())).rejects.toMatchObject({ code: "READ_ONLY" });
      await expect(svc.deleteEntry(tx, auto.id)).rejects.toMatchObject({ code: "READ_ONLY" });

      await svc.deleteEntry(tx, id);
      expect(await svc.getTransaction(tx, id)).toBeNull();
      expect(await bal(tx, BANK)).toBe(before);
    });
  });

  it("chuyển tiền & đổi ngoại tệ: 2 vế cùng nhóm; tổng thu chi toàn sổ không tính chuyển nội bộ; xoá cả cặp", async () => {
    await inTx(async (tx) => {
      const [b0, v0] = [await bal(tx, BANK), await bal(tx, VISA)];
      const all0 = await svc.listTransactions(tx);
      const g = await svc.createTransfer(tx, {
        fromAccountId: BANK,
        toAccountId: VISA,
        amountFrom: "10tr",
        amountTo: null,
        fxRate: null,
        occurredAt: "2026-11-04",
        note: null,
      });
      expect([await bal(tx, BANK), await bal(tx, VISA)]).toEqual([b0 - 1_000_000_000n, v0 + 1_000_000_000n]);
      const all1 = await svc.listTransactions(tx);
      expect([all1.inVnd, all1.outVnd, all1.total]).toEqual([all0.inVnd, all0.outVnd, all0.total + 2]);
      const one = await svc.listTransactions(tx, { accountId: VISA, from: "2026-11-04", to: "2026-11-04" });
      expect(one.rows).toMatchObject([{ source: "TRANSFER", direction: "IN", amountVnd: 10_000_000n, counterparty: "Ngân hàng chính" }]);
      expect(one.inVnd).toBe(10_000_000n); // xem một tài khoản thì có tính

      // đổi VND → USD
      const [{ id: usd }] = await tx<{ id: string }[]>`INSERT INTO accounts (name, currency, kind) VALUES ('Ví USD thử', 'USD', 'EWALLET') RETURNING id::text`;
      await svc.createTransfer(tx, {
        fromAccountId: BANK,
        toAccountId: usd,
        amountFrom: "2.640.000",
        amountTo: "100",
        fxRate: null,
        occurredAt: "2026-11-04",
        note: null,
      });
      const u = (await svc.listAccountBalances(tx)).find((a) => a.id === usd)!;
      expect([u.balanceCents, u.balanceVnd]).toEqual([10_000n, 2_640_000n]); // tỷ giá gần nhất = 26.400 của đơn mua
      await expect(
        svc.createTransfer(tx, {
          fromAccountId: BANK,
          toAccountId: usd,
          amountFrom: "1tr",
          amountTo: null,
          fxRate: null,
          occurredAt: "2026-11-04",
          note: null,
        }),
      ).rejects.toMatchObject({ field: "amountTo" });

      // bút toán USD nhập tay: không nhập tỷ giá → dùng tỷ giá gần nhất
      const e = await svc.saveManualEntry(tx, null, entry({ accountId: usd, amount: "20", categoryCode: "OPEX_TELECOM" }));
      expect(await svc.getTransaction(tx, e)).toMatchObject({ amountCents: 2_000n, amountVnd: 528_000n, currency: "USD" });

      const leg = one.rows[0];
      await svc.deleteEntry(tx, leg.id);
      const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM cash_transactions WHERE transfer_group_id = ${g} AND deleted_at IS NULL`;
      expect(n).toBe(0);
      expect(await bal(tx, VISA)).toBe(v0);
    });
  });

  it("đối soát: khớp → chênh 0; lệch + ghi điều chỉnh → số dư hệ thống bằng sao kê", async () => {
    await inTx(async (tx) => {
      const sys = await svc.balanceAt(tx, BANK, "2026-10-31");
      expect(sys).toBe(4_979_559_200n);
      const ok = await svc.reconcile(tx, { accountId: BANK, asOf: "2026-10-31", statementCents: sys, adjust: true, fxRate: null, note: null });
      expect([ok.diffCents, ok.adjusted]).toEqual([0n, false]);
      const off = await svc.reconcile(tx, { accountId: BANK, asOf: "2026-10-31", statementCents: sys - 10_000_000n, adjust: true, fxRate: null, note: null });
      expect([off.diffCents, off.adjusted]).toEqual([-10_000_000n, true]);
      expect(await svc.balanceAt(tx, BANK, "2026-10-31")).toBe(sys - 10_000_000n);
      const recs = await svc.listReconciliations(tx, BANK);
      expect(recs.map((r) => [r.diffCents, r.adjusted])).toEqual([
        [-10_000_000n, true],
        [0n, false],
      ]);
      const adj = (await svc.listTransactions(tx, { accountId: BANK, category: "ADJUST_OUT" })).rows;
      expect(adj).toMatchObject([{ source: "ADJUSTMENT", amountVnd: 100_000n, date: "2026-10-31" }]);
      // sổ một tài khoản: đầu kỳ + luỹ kế = cuối kỳ
      const st = await svc.accountStatement(tx, BANK, "2026-10-01", "2026-10-31");
      expect(st.openingCents).toBe(0n);
      expect(st.closingCents).toBe(sys - 10_000_000n);
      expect(st.rows.at(-1)!.balanceCents).toBe(st.closingCents);
      const acc = (await svc.listAccountBalances(tx)).find((a) => a.id === BANK)!;
      expect(acc.lastReconciliation).toEqual({ asOf: "2026-10-31", diffCents: -10_000_000n });
    });
  });

  it("công nợ: phải thu đơn bán còn nợ, chi phí bán hàng chưa trả → đã trả; tổng hợp tài sản", async () => {
    await inTx(async (tx) => {
      // khách trả lại một phần tiền → đơn còn nợ
      await tx`INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, sale_id)
               VALUES (${BANK}, 'OUT', 4500000, 4500000, '2026-10-24T10:00:00+07', 'SALE_REFUND', ${SALE1})`;
      const [{ id: exp }] = await tx<{ id: string }[]>`
        INSERT INTO sale_expenses (sale_id, kind, amount_vnd) VALUES (${SALE1}, 'COD_FEE', 25000) RETURNING id::text`;
      const d = await svc.getDebts(tx);
      expect(d.receivables).toMatchObject([
        { kind: "SALE", label: "Đơn bán BH-2026-0001", party: "Khách A", balanceVnd: 4_500_000n, href: `/ban-hang/${SALE1}` },
      ]);
      expect(d.payables.find((p) => p.id === exp)).toMatchObject({ kind: "SALE_EXPENSE", label: "Phí thu hộ · BH-2026-0001", amountVnd: 25_000n });
      await svc.markPaid(tx, { kind: "SALE_EXPENSE", id: exp, accountId: BANK, paidAt: "2026-10-24" });
      expect(await linked(tx, "sale_expense_id", exp)).toMatchObject([{ amount_vnd: "25000", category_code: "SALE_EXPENSE" }]);
      await expect(svc.markPaid(tx, { kind: "SALE_EXPENSE", id: exp, accountId: BANK, paidAt: "2026-10-24" })).rejects.toMatchObject({ code: "NOT_FOUND" });

      const accounts = await svc.listAccountBalances(tx);
      const s = await svc.cashSummary(tx, accounts, await svc.getDebts(tx));
      expect(s.capitalInGoodsVnd).toBe(6_979_336n); // AirPods còn tồn
      expect(s.receivableVnd).toBe(4_500_000n);
      expect(s.netLiquidVnd).toBe(s.cashVnd + s.capitalInGoodsVnd + s.receivableVnd - s.payableVnd);
    });
  });

  it("dòng tiền tuần không tính chuyển tiền; danh mục tự tạo: thêm / sửa / không xoá khi đã dùng", async () => {
    await inTx(async (tx) => {
      const w0 = await svc.weeklyCashflow(tx, "2026-11-05", 6);
      await svc.createTransfer(tx, {
        fromAccountId: BANK,
        toAccountId: VISA,
        amountFrom: "5tr",
        amountTo: null,
        fxRate: null,
        occurredAt: "2026-11-04",
        note: null,
      });
      await svc.saveManualEntry(tx, null, entry({ occurredAt: "2026-11-04", amount: "300k" }));
      const w1 = await svc.weeklyCashflow(tx, "2026-11-05", 6);
      expect(w1.map((w) => w.week)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
      expect(w1.at(-1)!.outVnd - w0.at(-1)!.outVnd).toBe(300_000n);
      expect(w1.find((w) => w.week === "2026-10-19")).toMatchObject({ inVnd: 34_500_000n });

      const code = await svc.saveCategory(tx, null, { name: "Thuê kho", direction: "OUT", isOperating: true });
      await expect(svc.saveCategory(tx, null, { name: "thuê kho", direction: "OUT", isOperating: true })).rejects.toMatchObject({ field: "name" });
      await svc.saveManualEntry(tx, null, entry({ categoryCode: code }));
      await expect(svc.saveCategory(tx, code, { name: "Thuê kho SG", direction: "IN", isOperating: false })).rejects.toMatchObject({ code: "IN_USE" });
      await svc.saveCategory(tx, code, { name: "Thuê kho SG", direction: "OUT", isOperating: true });
      await expect(svc.deleteCategory(tx, code)).rejects.toMatchObject({ code: "IN_USE" });
      await expect(svc.saveCategory(tx, "PURCHASE", { name: "Mua hàng", direction: "OUT", isOperating: false })).rejects.toMatchObject({ code: "READ_ONLY" });
      const c2 = await svc.saveCategory(tx, null, { name: "Tiền thưởng", direction: "IN", isOperating: false });
      await svc.deleteCategory(tx, c2);
      const cats = await svc.listCategories(tx);
      expect(cats.find((c) => c.code === code)).toMatchObject({ name: "Thuê kho SG", manual: true, usageCount: 1 });
      expect(cats.find((c) => c.code === c2)).toBeUndefined();
    });
  });
});
