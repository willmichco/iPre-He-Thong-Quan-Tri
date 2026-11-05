/**
 * Sổ quỹ (Thu chi) + công nợ.
 *
 * - Bút toán TỰ SINH: `syncPurchaseOrderEntry` / `syncCostEntry` / `syncSaleExpenseEntry` được gọi trong CÙNG
 *   transaction với thao tác sửa chứng từ gốc → mỗi chứng từ đã trả có đúng một bút toán khớp số tiền, tài khoản,
 *   ngày trả; chứng từ bị xoá / chuyển về "chưa trả" → bút toán bị xoá mềm. Tiền bán hàng do dịch vụ bán hàng ghi.
 * - Nhập tay: chi phí vận hành, thu khác, góp / rút vốn, nộp thuế; chuyển tiền / đổi ngoại tệ (2 bút toán cùng nhóm).
 * - Đối soát: số dư sao kê so với số dư hệ thống cuối một ngày; tuỳ chọn ghi bút toán điều chỉnh.
 * - Công nợ: phải thu (đơn bán còn nợ, hoàn phí chưa nhận) · phải trả (đơn mua, cước, chi phí bán hàng chưa trả).
 * Mọi thay đổi ghi `audit_logs`.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  centsToDecimal,
  fillWeeks,
  isManualCategory,
  lastWeeks,
  parseAmount,
  reconcileDiff,
  sourceOf,
  toCents,
  transferLegs,
  vndFromUsdCents,
  type Currency,
  type Direction,
  type ManualEntryInput,
  type SourceType,
  type TransferInput,
  type WeekFlow,
} from "@/domain/ledger";

type Db = Sql | TransactionSql;

export type LedgerErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "READ_ONLY" | "IN_USE";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const noonVn = (d: string) => `${d}T12:00:00+07:00`;
const endOfDayVn = (d: string) => `${d}T23:59:59+07:00`;
const VN_DATE = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

/** Ghi nhật ký. `id` không phải uuid (vd mã danh mục) → entity_id để trống, mã nằm trong dữ liệu `after`/`before`. */
async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, id: string, before: unknown, after: unknown) {
  const json = (v: unknown) => (v == null ? null : tx.json(JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as never));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  const tag = (v: unknown) => (uuid || v == null ? v : { code: id, ...(v as object) });
  await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
           VALUES (${action}, ${entityType}, ${uuid}, ${json(tag(before))}, ${json(tag(after))})`;
}

// ---- Bút toán tự sinh -----------------------------------------------------------------------------------

type LinkColumn = "purchase_order_id" | "cost_id" | "sale_expense_id";

interface WantedEntry {
  account_id: string;
  direction: Direction;
  amount: string;
  amount_vnd: string;
  occurred_at: string;
  category_code: string;
  counterparty: string | null;
  note: string | null;
}

/** Đưa bút toán liên kết với một chứng từ về đúng trạng thái mong muốn (null = không còn bút toán). */
async function upsertLinked(tx: TransactionSql, col: LinkColumn, sourceId: string, want: WantedEntry | null) {
  const [cur] = await tx<{ id: string }[]>`
    SELECT id::text FROM cash_transactions WHERE ${tx(col)} = ${sourceId} AND deleted_at IS NULL FOR UPDATE`;
  if (!want) {
    if (cur) await tx`UPDATE cash_transactions SET deleted_at = now() WHERE id = ${cur.id}`;
    return;
  }
  if (cur) await tx`UPDATE cash_transactions SET ${tx(want)} WHERE id = ${cur.id}`;
  else await tx`INSERT INTO cash_transactions ${tx({ ...want, [col]: sourceId })}`;
}

/** Đơn mua đã trả (tài khoản + ngày trả) → 1 bút toán chi "Thanh toán đơn mua tại Mỹ". */
export async function syncPurchaseOrderEntry(tx: TransactionSql, poId: string) {
  const [po] = await tx<
    {
      deleted: boolean;
      account_id: string | null;
      paid_at: string | null;
      total: string;
      currency: Currency;
      gross: string;
      acc_currency: Currency | null;
      supplier: string | null;
      order_number: string | null;
    }[]
  >`
    SELECT po.deleted_at IS NOT NULL AS deleted, po.payment_account_id::text AS account_id, po.paid_at::text, po.total_vnd::text AS total,
           po.currency::text AS currency, (po.subtotal + po.sales_tax + po.seller_shipping - po.discount)::text AS gross,
           a.currency::text AS acc_currency, sp.name AS supplier, po.order_number
      FROM purchase_orders po LEFT JOIN accounts a ON a.id = po.payment_account_id LEFT JOIN suppliers sp ON sp.id = po.supplier_id
     WHERE po.id = ${poId}`;
  if (!po) return;
  const total = BigInt(po.total);
  if (po.deleted || !po.paid_at || !po.account_id || total <= 0n) return upsertLinked(tx, "purchase_order_id", poId, null);
  let amount: string;
  if (po.acc_currency === "USD") {
    if (po.currency !== "USD") throw new LedgerError("INVALID_INPUT", "Đơn trả bằng VND thì không chọn tài khoản USD", "paymentAccountId");
    if (toCents(po.gross) <= 0n) return upsertLinked(tx, "purchase_order_id", poId, null);
    amount = po.gross;
  } else amount = `${total}.00`;
  await upsertLinked(tx, "purchase_order_id", poId, {
    account_id: po.account_id,
    direction: "OUT",
    amount,
    amount_vnd: total.toString(),
    occurred_at: po.paid_at,
    category_code: "PURCHASE",
    counterparty: po.supplier,
    note: po.order_number ? `Đơn ${po.order_number}` : null,
  });
}

/** Chi phí theo chặng đã trả → bút toán chi (số âm = hoàn phí → bút toán thu). */
export async function syncCostEntry(tx: TransactionSql, costId: string) {
  const [c] = await tx<
    {
      deleted: boolean;
      account_id: string | null;
      paid_at: string | null;
      amount: string;
      amount_vnd: string;
      currency: Currency;
      acc_currency: Currency | null;
      description: string | null;
    }[]
  >`
    SELECT c.deleted_at IS NOT NULL AS deleted, c.account_id::text, c.paid_at::text, c.amount::text, c.amount_vnd::text,
           c.currency::text AS currency, a.currency::text AS acc_currency, c.description
      FROM costs c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ${costId}`;
  if (!c) return;
  const vnd = BigInt(c.amount_vnd);
  if (c.deleted || !c.paid_at || !c.account_id || vnd === 0n) return upsertLinked(tx, "cost_id", costId, null);
  const abs = (s: string) => (s.startsWith("-") ? s.slice(1) : s);
  let amount: string;
  if (c.acc_currency === "USD") {
    if (c.currency !== "USD") throw new LedgerError("INVALID_INPUT", "Chi phí tính bằng VND thì không trả từ tài khoản USD", "accountId");
    amount = abs(c.amount);
  } else amount = `${vnd < 0n ? -vnd : vnd}.00`;
  await upsertLinked(tx, "cost_id", costId, {
    account_id: c.account_id,
    direction: vnd > 0n ? "OUT" : "IN",
    amount,
    amount_vnd: (vnd < 0n ? -vnd : vnd).toString(),
    occurred_at: c.paid_at,
    category_code: vnd > 0n ? "LANDED_COST" : "LANDED_COST_REFUND",
    counterparty: null,
    note: c.description,
  });
}

/** Chi phí bán hàng (ship cho khách, phí sàn…) đã trả → bút toán chi. */
export async function syncSaleExpenseEntry(tx: TransactionSql, expenseId: string) {
  const [e] = await tx<{ account_id: string | null; paid_at: string | null; amount: string; acc_currency: Currency | null; kind: string }[]>`
    SELECT e.account_id::text, e.paid_at::text, e.amount_vnd::text AS amount, a.currency::text AS acc_currency, e.kind
      FROM sale_expenses e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.id = ${expenseId}`;
  if (!e) return;
  if (!e.paid_at || !e.account_id) return upsertLinked(tx, "sale_expense_id", expenseId, null);
  if (e.acc_currency !== "VND") throw new LedgerError("INVALID_INPUT", "Chi phí bán hàng phải trả từ tài khoản VND", "accountId");
  await upsertLinked(tx, "sale_expense_id", expenseId, {
    account_id: e.account_id,
    direction: "OUT",
    amount: `${e.amount}.00`,
    amount_vnd: e.amount,
    occurred_at: e.paid_at,
    category_code: "SALE_EXPENSE",
    counterparty: null,
    note: null,
  });
}

// ---- Tài khoản & số dư ----------------------------------------------------------------------------------

export interface AccountBalance {
  id: string;
  name: string;
  kind: string;
  currency: Currency;
  isActive: boolean;
  openingCents: bigint;
  inCents: bigint;
  outCents: bigint;
  balanceCents: bigint;
  /** số dư quy đổi VND (USD theo tỷ giá gần nhất; null nếu chưa có tỷ giá) */
  balanceVnd: bigint | null;
  txnCount: number;
  lastReconciliation: { asOf: string; diffCents: bigint } | null;
}

async function latestRate(db: Db): Promise<{ rate: string; date: string } | null> {
  const [r] = await db<{ rate: string; date: string }[]>`
    SELECT rate::text, rate_date::text AS date FROM exchange_rates WHERE base = 'USD' AND quote = 'VND' ORDER BY rate_date DESC, created_at DESC LIMIT 1`;
  if (r) return r;
  // chưa có bảng tỷ giá: dùng tỷ giá thực tế của đơn mua gần nhất
  const [po] = await db<{ rate: string; date: string }[]>`
    SELECT fx_rate::text AS rate, ${db.unsafe(VN_DATE("ordered_at"))} AS date FROM purchase_orders
     WHERE currency = 'USD' AND deleted_at IS NULL ORDER BY ordered_at DESC LIMIT 1`;
  return po ?? null;
}

/** Số dư từng tài khoản (tới hết ngày `at` nếu có). */
export async function listAccountBalances(db: Db, at?: string | null): Promise<AccountBalance[]> {
  const until = at ? db`AND t.occurred_at <= ${endOfDayVn(at)}` : db``;
  const rows = await db<
    {
      id: string;
      name: string;
      kind: string;
      currency: Currency;
      is_active: boolean;
      opening: string;
      in_sum: string;
      out_sum: string;
      n: number;
      rec_as_of: string | null;
      rec_diff: string | null;
    }[]
  >`
    WITH t AS (
      SELECT t.account_id,
             COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'IN'), 0)  AS in_sum,
             COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'OUT'), 0) AS out_sum,
             COUNT(*)::int AS n
        FROM cash_transactions t WHERE t.deleted_at IS NULL ${until} GROUP BY t.account_id)
    SELECT a.id::text, a.name, a.kind, a.currency::text AS currency, a.is_active, a.opening_balance::text AS opening,
           COALESCE(t.in_sum, 0)::text AS in_sum, COALESCE(t.out_sum, 0)::text AS out_sum, COALESCE(t.n, 0) AS n,
           r.as_of::text AS rec_as_of, (r.statement_balance - r.system_balance)::text AS rec_diff
      FROM accounts a LEFT JOIN t ON t.account_id = a.id
      LEFT JOIN LATERAL (SELECT as_of, statement_balance, system_balance FROM account_reconciliations
                          WHERE account_id = a.id ORDER BY as_of DESC, created_at DESC LIMIT 1) r ON true
     ORDER BY a.is_active DESC, a.currency DESC, a.name`;
  const rate = rows.some((r) => r.currency === "USD") ? await latestRate(db) : null;
  return rows.map((r) => {
    const opening = toCents(r.opening);
    const inC = toCents(r.in_sum);
    const outC = toCents(r.out_sum);
    const bal = opening + inC - outC;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      currency: r.currency,
      isActive: r.is_active,
      openingCents: opening,
      inCents: inC,
      outCents: outC,
      balanceCents: bal,
      balanceVnd: r.currency === "VND" ? bal / 100n : rate ? vndFromUsdCents(bal, rate.rate) : null,
      txnCount: r.n,
      lastReconciliation: r.rec_as_of ? { asOf: r.rec_as_of, diffCents: toCents(r.rec_diff!) } : null,
    };
  });
}

async function accountOf(db: Db, id: string, field = "accountId") {
  const [a] = await db<{ id: string; name: string; currency: Currency; is_active: boolean; opening: string }[]>`
    SELECT id::text, name, currency::text AS currency, is_active, opening_balance::text AS opening FROM accounts WHERE id = ${id}`;
  if (!a) throw new LedgerError("NOT_FOUND", "Không tìm thấy tài khoản", field);
  return a;
}

/** Số dư (xu) của một tài khoản tới hết ngày `asOf` (giờ Việt Nam). */
export async function balanceAt(db: Db, accountId: string, asOf: string): Promise<bigint> {
  const a = await accountOf(db, accountId);
  const [r] = await db<{ net: string }[]>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0)::text AS net
      FROM cash_transactions WHERE account_id = ${accountId} AND deleted_at IS NULL AND occurred_at <= ${endOfDayVn(asOf)}`;
  return toCents(a.opening) + toCents(r.net);
}

// ---- Danh mục thu chi -----------------------------------------------------------------------------------

export interface CategoryRow {
  code: string;
  name: string;
  direction: Direction;
  isOperating: boolean;
  isSystem: boolean;
  manual: boolean;
  usageCount: number;
}

export async function listCategories(db: Db): Promise<CategoryRow[]> {
  const rows = await db<{ code: string; name: string; direction: Direction; is_operating: boolean; is_system: boolean; n: number }[]>`
    SELECT c.code, c.name, c.direction::text AS direction, c.is_operating, c.is_system,
           (SELECT COUNT(*)::int FROM cash_transactions t WHERE t.category_code = c.code AND t.deleted_at IS NULL) AS n
      FROM cash_categories c ORDER BY c.direction, c.is_system DESC, c.name`;
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    direction: r.direction,
    isOperating: r.is_operating,
    isSystem: r.is_system,
    manual: isManualCategory({ code: r.code, isSystem: r.is_system }),
    usageCount: r.n,
  }));
}

/** Thêm / sửa danh mục do người dùng tạo. Danh mục hệ thống không sửa được; đã dùng thì không đổi chiều thu/chi. */
export async function saveCategory(db: Db, code: string | null, input: { name: string; direction: Direction; isOperating: boolean }) {
  const name = input.name.trim();
  if (name.length < 2) throw new LedgerError("INVALID_INPUT", "Nhập tên danh mục", "name");
  return db.begin(async (tx) => {
    const [dup] = await tx`SELECT 1 FROM cash_categories WHERE lower(name) = lower(${name}) AND code IS DISTINCT FROM ${code}`;
    if (dup) throw new LedgerError("INVALID_INPUT", "Đã có danh mục cùng tên", "name");
    if (!code) {
      const newCode = `U_${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2)
        .toString(36)
        .toUpperCase()}`;
      await tx`INSERT INTO cash_categories (code, name, direction, is_operating, is_system)
               VALUES (${newCode}, ${name}, ${input.direction}, ${input.isOperating}, false)`;
      await audit(tx, "CREATE", "cash_category", newCode, null, input);
      return newCode;
    }
    const [cur] = await tx<{ is_system: boolean; direction: Direction; n: number }[]>`
      SELECT is_system, direction::text AS direction,
             (SELECT COUNT(*)::int FROM cash_transactions WHERE category_code = c.code AND deleted_at IS NULL) AS n
        FROM cash_categories c WHERE code = ${code} FOR UPDATE`;
    if (!cur) throw new LedgerError("NOT_FOUND", "Không tìm thấy danh mục");
    if (cur.is_system) throw new LedgerError("READ_ONLY", "Danh mục hệ thống không sửa được");
    if (cur.n && cur.direction !== input.direction)
      throw new LedgerError("IN_USE", `Danh mục đã có ${cur.n} bút toán — không đổi chiều thu/chi được`, "direction");
    await tx`UPDATE cash_categories SET name = ${name}, direction = ${input.direction}, is_operating = ${input.isOperating} WHERE code = ${code}`;
    await audit(tx, "UPDATE", "cash_category", code, cur, input);
    return code;
  });
}

export async function deleteCategory(db: Db, code: string) {
  return db.begin(async (tx) => {
    const [cur] = await tx<{ is_system: boolean; n: number }[]>`
      SELECT is_system, (SELECT COUNT(*)::int FROM cash_transactions WHERE category_code = c.code) AS n
        FROM cash_categories c WHERE code = ${code} FOR UPDATE`;
    if (!cur) throw new LedgerError("NOT_FOUND", "Không tìm thấy danh mục");
    if (cur.is_system) throw new LedgerError("READ_ONLY", "Danh mục hệ thống không xoá được");
    if (cur.n) throw new LedgerError("IN_USE", `Danh mục đã có ${cur.n} bút toán — không xoá được`);
    await tx`DELETE FROM cash_categories WHERE code = ${code}`;
    await audit(tx, "DELETE", "cash_category", code, cur, null);
  });
}

// ---- Sổ quỹ ---------------------------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  accountId: string;
  account: string;
  currency: Currency;
  direction: Direction;
  amountCents: bigint;
  amountVnd: bigint;
  date: string;
  occurredAt: string;
  categoryCode: string;
  category: string;
  isOperating: boolean;
  source: SourceType;
  /** chứng từ gốc (bút toán tự sinh) */
  link: { href: string; label: string } | null;
  transferGroupId: string | null;
  counterparty: string | null;
  note: string | null;
}

export interface LedgerFilter {
  accountId?: string | null;
  category?: string | null;
  from?: string | null;
  /** đến hết ngày này */
  to?: string | null;
  source?: "AUTO" | "MANUAL" | null;
  q?: string | null;
  limit?: number;
}

const ledgerSelect = (db: Db) => db`
  SELECT t.id::text, t.account_id::text, a.name AS account, a.currency::text AS currency, t.direction::text AS direction,
         t.amount::text AS amount, t.amount_vnd::text AS amount_vnd, ${db.unsafe(VN_DATE("t.occurred_at"))} AS date, t.occurred_at::text,
         t.category_code, cc.name AS category, cc.is_operating,
         t.purchase_order_id::text, t.cost_id::text, t.sale_id::text, t.sale_expense_id::text, t.transfer_group_id::text,
         t.counterparty, t.note,
         po.batch_id::text AS po_batch, po.order_number,
         c.shipment_id::text AS cost_shipment, COALESCE(c.batch_id, cpo.batch_id, ci.batch_id)::text AS cost_batch, c.kind::text AS cost_kind,
         COALESCE(s.code, se_s.code) AS sale_code, COALESCE(t.sale_id, se.sale_id)::text AS sale_ref,
         b.code AS batch_code
    FROM cash_transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN cash_categories cc ON cc.code = t.category_code
    LEFT JOIN purchase_orders po ON po.id = t.purchase_order_id
    LEFT JOIN costs c ON c.id = t.cost_id
    LEFT JOIN purchase_orders cpo ON cpo.id = c.purchase_order_id
    LEFT JOIN items ci ON ci.id = c.item_id
    LEFT JOIN batches b ON b.id = COALESCE(po.batch_id, c.batch_id, cpo.batch_id, ci.batch_id)
    LEFT JOIN sales s ON s.id = t.sale_id
    LEFT JOIN sale_expenses se ON se.id = t.sale_expense_id
    LEFT JOIN sales se_s ON se_s.id = se.sale_id`;

type RawLedger = {
  id: string;
  account_id: string;
  account: string;
  currency: Currency;
  direction: Direction;
  amount: string;
  amount_vnd: string;
  date: string;
  occurred_at: string;
  category_code: string;
  category: string;
  is_operating: boolean;
  purchase_order_id: string | null;
  cost_id: string | null;
  sale_id: string | null;
  sale_expense_id: string | null;
  transfer_group_id: string | null;
  counterparty: string | null;
  note: string | null;
  po_batch: string | null;
  order_number: string | null;
  cost_shipment: string | null;
  cost_batch: string | null;
  cost_kind: string | null;
  sale_code: string | null;
  sale_ref: string | null;
  batch_code: string | null;
};

function mapLedger(r: RawLedger): LedgerRow {
  const source = sourceOf({
    purchaseOrderId: r.purchase_order_id,
    costId: r.cost_id,
    saleId: r.sale_id,
    saleExpenseId: r.sale_expense_id,
    transferGroupId: r.transfer_group_id,
    categoryCode: r.category_code,
  });
  let link: LedgerRow["link"] = null;
  if (source === "PURCHASE_ORDER" && r.po_batch)
    link = { href: `/chuyen-hang/${r.po_batch}`, label: `Đơn mua ${r.order_number ?? ""} · ${r.batch_code ?? ""}`.replace(/\s+·/, " ·").trim() };
  else if (source === "COST")
    link = r.cost_shipment
      ? { href: `/van-chuyen/${r.cost_shipment}`, label: `Chi phí kiện${r.batch_code ? ` · ${r.batch_code}` : ""}` }
      : r.cost_batch
        ? { href: `/chuyen-hang/${r.cost_batch}`, label: `Chi phí chuyến ${r.batch_code ?? ""}`.trim() }
        : null;
  else if ((source === "SALE" || source === "SALE_EXPENSE") && r.sale_ref)
    link = { href: `/ban-hang/${r.sale_ref}`, label: `Đơn bán ${r.sale_code ?? ""}`.trim() };
  return {
    id: r.id,
    accountId: r.account_id,
    account: r.account,
    currency: r.currency,
    direction: r.direction,
    amountCents: toCents(r.amount),
    amountVnd: BigInt(r.amount_vnd),
    date: r.date,
    occurredAt: r.occurred_at,
    categoryCode: r.category_code,
    category: r.category,
    isOperating: r.is_operating,
    source,
    link,
    transferGroupId: r.transfer_group_id,
    counterparty: r.counterparty,
    note: r.note,
  };
}

export interface LedgerPage {
  rows: LedgerRow[];
  /** tổng theo bộ lọc (không tính chuyển tiền nội bộ khi xem tất cả tài khoản) */
  inVnd: bigint;
  outVnd: bigint;
  total: number;
  truncated: boolean;
}

export async function listTransactions(db: Db, f: LedgerFilter = {}): Promise<LedgerPage> {
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 2000);
  const q = f.q?.trim();
  const where = db`
    WHERE t.deleted_at IS NULL
      ${f.accountId ? db`AND t.account_id = ${f.accountId}` : db``}
      ${f.category ? db`AND t.category_code = ${f.category}` : db``}
      ${f.from ? db`AND t.occurred_at >= ${`${f.from}T00:00:00+07:00`}` : db``}
      ${f.to ? db`AND t.occurred_at <= ${endOfDayVn(f.to)}` : db``}
      ${
        f.source === "MANUAL"
          ? db`AND t.purchase_order_id IS NULL AND t.cost_id IS NULL AND t.sale_id IS NULL AND t.sale_expense_id IS NULL`
          : f.source === "AUTO"
            ? db`AND num_nonnulls(t.purchase_order_id, t.cost_id, t.sale_id, t.sale_expense_id) = 1`
            : db``
      }
      ${q ? db`AND (t.note ILIKE ${`%${q}%`} OR t.counterparty ILIKE ${`%${q}%`} OR cc.name ILIKE ${`%${q}%`})` : db``}`;
  const rows = await db<RawLedger[]>`${ledgerSelect(db)} ${where} ORDER BY t.occurred_at DESC, t.created_at DESC, t.id LIMIT ${limit + 1}`;
  const internal = f.accountId ? db`` : db`AND t.transfer_group_id IS NULL`;
  const [sum] = await db<{ in_vnd: string; out_vnd: string; n: number }[]>`
    SELECT COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.direction = 'IN' ${internal}), 0)::text AS in_vnd,
           COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.direction = 'OUT' ${internal}), 0)::text AS out_vnd,
           COUNT(*)::int AS n
      FROM cash_transactions t JOIN cash_categories cc ON cc.code = t.category_code ${where}`;
  return {
    rows: rows.slice(0, limit).map(mapLedger),
    inVnd: BigInt(sum.in_vnd),
    outVnd: BigInt(sum.out_vnd),
    total: sum.n,
    truncated: rows.length > limit,
  };
}

export async function getTransaction(db: Db, id: string): Promise<LedgerRow | null> {
  const [r] = await db<RawLedger[]>`${ledgerSelect(db)} WHERE t.id = ${id} AND t.deleted_at IS NULL`;
  return r ? mapLedger(r) : null;
}

/** Sổ quỹ một tài khoản trong kỳ, kèm số dư đầu kỳ và số dư sau từng bút toán (cũ → mới). */
export async function accountStatement(db: Db, accountId: string, from: string, to: string) {
  const acc = await accountOf(db, accountId);
  const [o] = await db<{ net: string }[]>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0)::text AS net
      FROM cash_transactions WHERE account_id = ${accountId} AND deleted_at IS NULL AND occurred_at < ${`${from}T00:00:00+07:00`}`;
  const opening = toCents(acc.opening) + toCents(o.net);
  const raw = await db<RawLedger[]>`
    ${ledgerSelect(db)} WHERE t.deleted_at IS NULL AND t.account_id = ${accountId}
      AND t.occurred_at >= ${`${from}T00:00:00+07:00`} AND t.occurred_at <= ${endOfDayVn(to)}
    ORDER BY t.occurred_at, t.created_at, t.id`;
  let b = opening;
  const rows = raw.map(mapLedger).map((r) => ({ ...r, balanceCents: (b = r.direction === "IN" ? b + r.amountCents : b - r.amountCents) }));
  return { account: { id: acc.id, name: acc.name, currency: acc.currency }, openingCents: opening, closingCents: b, rows };
}

// ---- Nhập tay -------------------------------------------------------------------------------------------

async function vndValue(tx: TransactionSql, currency: Currency, cents: bigint, fxRate: string | null) {
  if (currency === "VND") return cents / 100n;
  const rate = fxRate ?? (await latestRate(tx))?.rate;
  if (!rate) throw new LedgerError("INVALID_INPUT", "Tài khoản USD: nhập tỷ giá để quy đổi VND", "fxRate");
  const v = vndFromUsdCents(cents, rate);
  if (v <= 0n) throw new LedgerError("INVALID_INPUT", "Số tiền quá nhỏ", "amount");
  return v;
}

/** Thêm / sửa bút toán nhập tay (chi vận hành, thu khác, góp / rút vốn, nộp thuế). */
export async function saveManualEntry(db: Db, id: string | null, input: ManualEntryInput): Promise<string> {
  return db.begin(async (tx) => {
    const acc = await accountOf(tx, input.accountId);
    if (!acc.is_active && !id) throw new LedgerError("INVALID_INPUT", "Tài khoản đã ngừng dùng", "accountId");
    const [cat] = await tx<{ code: string; direction: Direction; is_system: boolean }[]>`
      SELECT code, direction::text AS direction, is_system FROM cash_categories WHERE code = ${input.categoryCode}`;
    if (!cat) throw new LedgerError("NOT_FOUND", "Không tìm thấy danh mục", "categoryCode");
    if (!isManualCategory({ code: cat.code, isSystem: cat.is_system }))
      throw new LedgerError("INVALID_INPUT", "Danh mục này do hệ thống tự ghi — nhập ở chứng từ gốc (đơn mua, chi phí, đơn bán)", "categoryCode");
    const cents = parseAmount(input.amount, acc.currency);
    if (cents === null)
      throw new LedgerError(
        "INVALID_INPUT",
        acc.currency === "VND" ? "Số tiền không hợp lệ (vd 2tr · 500k · 2.000.000)" : "Số tiền USD không hợp lệ",
        "amount",
      );
    const values = {
      account_id: acc.id,
      direction: cat.direction,
      amount: centsToDecimal(cents),
      amount_vnd: (await vndValue(tx, acc.currency, cents, input.fxRate)).toString(),
      occurred_at: noonVn(input.occurredAt),
      category_code: cat.code,
      counterparty: input.counterparty,
      note: input.note,
    };
    if (!id) {
      const [r] = await tx<{ id: string }[]>`INSERT INTO cash_transactions ${tx(values)} RETURNING id::text`;
      await audit(tx, "CREATE", "cash_transaction", r.id, null, values);
      return r.id;
    }
    const [before] = await tx<RawLedger[]>`${ledgerSelect(tx)} WHERE t.id = ${id} AND t.deleted_at IS NULL FOR UPDATE OF t`;
    if (!before) throw new LedgerError("NOT_FOUND", "Không tìm thấy bút toán");
    const src = mapLedger(before).source;
    if (src !== "MANUAL") throw new LedgerError("READ_ONLY", "Bút toán tự sinh — sửa ở chứng từ gốc");
    await tx`UPDATE cash_transactions SET ${tx(values)} WHERE id = ${id}`;
    await audit(tx, "UPDATE", "cash_transaction", id, before, values);
    return id;
  });
}

/** Xoá (mềm) bút toán nhập tay / điều chỉnh; chuyển tiền thì xoá cả hai vế. Bút toán tự sinh → chặn. */
export async function deleteEntry(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [r] = await tx<RawLedger[]>`${ledgerSelect(tx)} WHERE t.id = ${id} AND t.deleted_at IS NULL FOR UPDATE OF t`;
    if (!r) throw new LedgerError("NOT_FOUND", "Không tìm thấy bút toán");
    const row = mapLedger(r);
    if (row.source === "TRANSFER")
      await tx`UPDATE cash_transactions SET deleted_at = now() WHERE transfer_group_id = ${row.transferGroupId} AND deleted_at IS NULL`;
    else if (row.source === "MANUAL" || row.source === "ADJUSTMENT") await tx`UPDATE cash_transactions SET deleted_at = now() WHERE id = ${id}`;
    else throw new LedgerError("READ_ONLY", `Bút toán tự sinh từ ${row.link?.label ?? "chứng từ gốc"} — xoá / sửa ở đó`);
    await audit(tx, "DELETE", "cash_transaction", id, r, null);
  });
}

/** Chuyển tiền nội bộ / đổi ngoại tệ: 2 bút toán (ra – vào) cùng `transfer_group_id`. */
export async function createTransfer(db: Db, input: TransferInput): Promise<string> {
  return db.begin(async (tx) => {
    const from = await accountOf(tx, input.fromAccountId, "fromAccountId");
    const to = await accountOf(tx, input.toAccountId, "toAccountId");
    if (!from.is_active) throw new LedgerError("INVALID_INPUT", "Tài khoản chuyển đi đã ngừng dùng", "fromAccountId");
    if (!to.is_active) throw new LedgerError("INVALID_INPUT", "Tài khoản nhận đã ngừng dùng", "toAccountId");
    const legs = transferLegs(from, to, input);
    if (!legs.ok) {
      const [field, msg] = Object.entries(legs.errors)[0];
      throw new LedgerError("INVALID_INPUT", msg, field);
    }
    const [{ g }] = await tx<{ g: string }[]>`SELECT gen_random_uuid()::text AS g`;
    const at = noonVn(input.occurredAt);
    const note = input.note ?? (from.currency === to.currency ? `${from.name} → ${to.name}` : `Đổi ${from.currency} → ${to.currency}`);
    const base = { occurred_at: at, transfer_group_id: g, amount_vnd: legs.vnd.toString(), note };
    await tx`INSERT INTO cash_transactions ${tx([
      { ...base, account_id: from.id, direction: "OUT", amount: centsToDecimal(legs.outCents), category_code: "TRANSFER_OUT", counterparty: to.name },
      { ...base, account_id: to.id, direction: "IN", amount: centsToDecimal(legs.inCents), category_code: "TRANSFER_IN", counterparty: from.name },
    ])}`;
    await audit(tx, "CREATE", "transfer", g, null, { ...input, vnd: legs.vnd });
    return g;
  });
}

// ---- Đối soát -------------------------------------------------------------------------------------------

export interface ReconcileInput {
  accountId: string;
  asOf: string;
  statementCents: bigint;
  /** ghi bút toán điều chỉnh cho khớp */
  adjust: boolean;
  fxRate: string | null;
  note: string | null;
}

export async function reconcile(db: Db, input: ReconcileInput) {
  return db.begin(async (tx) => {
    const acc = await accountOf(tx, input.accountId);
    await tx`SELECT 1 FROM accounts WHERE id = ${acc.id} FOR UPDATE`;
    const system = await balanceAt(tx, acc.id, input.asOf);
    const d = reconcileDiff(input.statementCents, system);
    let adjustmentId: string | null = null;
    if (input.adjust && d.direction) {
      const values = {
        account_id: acc.id,
        direction: d.direction,
        amount: centsToDecimal(d.amount),
        amount_vnd: (await vndValue(tx, acc.currency, d.amount, input.fxRate)).toString(),
        occurred_at: endOfDayVn(input.asOf),
        category_code: d.direction === "IN" ? "ADJUST_IN" : "ADJUST_OUT",
        counterparty: null,
        note: input.note ?? `Điều chỉnh theo sao kê ngày ${input.asOf.split("-").reverse().join("/")}`,
      };
      const [r] = await tx<{ id: string }[]>`INSERT INTO cash_transactions ${tx(values)} RETURNING id::text`;
      adjustmentId = r.id;
    }
    const [rec] = await tx<{ id: string }[]>`
      INSERT INTO account_reconciliations (account_id, as_of, statement_balance, system_balance, adjustment_txn_id, note, created_at)
      VALUES (${acc.id}, ${input.asOf}, ${centsToDecimal(input.statementCents)}, ${centsToDecimal(system)}, ${adjustmentId}, ${input.note}, clock_timestamp())
      RETURNING id::text`;
    await audit(tx, "CREATE", "reconciliation", rec.id, null, { ...input, system, diff: d.diff, adjustmentId });
    return { id: rec.id, systemCents: system, diffCents: d.diff, adjusted: !!adjustmentId, currency: acc.currency };
  });
}

export async function listReconciliations(db: Db, accountId: string) {
  const rows = await db<{ id: string; as_of: string; statement: string; system: string; adjusted: boolean; note: string | null; created_at: string }[]>`
    SELECT r.id::text, r.as_of::text, r.statement_balance::text AS statement, r.system_balance::text AS system,
           (r.adjustment_txn_id IS NOT NULL AND t.deleted_at IS NULL) AS adjusted, r.note, r.created_at::text
      FROM account_reconciliations r LEFT JOIN cash_transactions t ON t.id = r.adjustment_txn_id
     WHERE r.account_id = ${accountId} ORDER BY r.as_of DESC, r.created_at DESC LIMIT 24`;
  return rows.map((r) => ({
    id: r.id,
    asOf: r.as_of,
    statementCents: toCents(r.statement),
    systemCents: toCents(r.system),
    diffCents: toCents(r.statement) - toCents(r.system),
    adjusted: r.adjusted,
    note: r.note,
  }));
}

// ---- Dòng tiền & tổng hợp -------------------------------------------------------------------------------

/** Dòng tiền vào / ra theo tuần (VND), không tính chuyển tiền nội bộ. */
export async function weeklyCashflow(db: Db, today: string, n = 12): Promise<WeekFlow[]> {
  const weeks = lastWeeks(today, n);
  const rows = await db<{ week: string; in_vnd: string; out_vnd: string }[]>`
    SELECT date_trunc('week', t.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS week,
           COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.direction = 'IN'), 0)::text AS in_vnd,
           COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.direction = 'OUT'), 0)::text AS out_vnd
      FROM cash_transactions t
     WHERE t.deleted_at IS NULL AND t.transfer_group_id IS NULL AND t.occurred_at >= ${`${weeks[0]}T00:00:00+07:00`}
     GROUP BY 1`;
  return fillWeeks(
    rows.map((r) => ({ week: r.week, inVnd: BigInt(r.in_vnd), outVnd: BigInt(r.out_vnd) })),
    weeks,
  );
}

export interface CashSummary {
  cashVnd: bigint;
  /** tài khoản USD chưa quy đổi được (chưa có tỷ giá) */
  unconvertedUsdCents: bigint;
  usdRate: { rate: string; date: string } | null;
  capitalInGoodsVnd: bigint;
  receivableVnd: bigint;
  payableVnd: bigint;
  /** tiền + vốn trong hàng + phải thu − phải trả */
  netLiquidVnd: bigint;
}

export async function cashSummary(db: Db, accounts: AccountBalance[], debts: Debts): Promise<CashSummary> {
  const [cap] = await db<{ v: string }[]>`SELECT COALESCE(SUM(capital_vnd), 0)::text AS v FROM v_capital_by_stage`;
  const usdRate = accounts.some((a) => a.currency === "USD") ? await latestRate(db) : null;
  const cashVnd = accounts.reduce((s, a) => s + (a.balanceVnd ?? 0n), 0n);
  const unconverted = accounts.filter((a) => a.balanceVnd === null).reduce((s, a) => s + a.balanceCents, 0n);
  const capital = BigInt(cap.v);
  return {
    cashVnd,
    unconvertedUsdCents: unconverted,
    usdRate,
    capitalInGoodsVnd: capital,
    receivableVnd: debts.receivableVnd,
    payableVnd: debts.payableVnd,
    netLiquidVnd: cashVnd + capital + debts.receivableVnd - debts.payableVnd,
  };
}

// ---- Công nợ --------------------------------------------------------------------------------------------

export interface Receivable {
  kind: "SALE" | "COST_REFUND";
  id: string;
  label: string;
  party: string | null;
  phone: string | null;
  status: string | null;
  date: string;
  totalVnd: bigint;
  paidVnd: bigint;
  balanceVnd: bigint;
  href: string;
}

export interface Payable {
  kind: "PURCHASE_ORDER" | "COST" | "SALE_EXPENSE";
  id: string;
  label: string;
  party: string | null;
  date: string;
  amountVnd: bigint;
  isEstimate: boolean;
  href: string;
}

export interface Debts {
  receivables: Receivable[];
  payables: Payable[];
  receivableVnd: bigint;
  payableVnd: bigint;
}

const COST_KIND_LABEL: Record<string, string> = {
  US_DOMESTIC_SHIPPING: "Ship nội địa Mỹ",
  INTL_SHIPPING: "Cước Mỹ → VN",
  INSURANCE: "Bảo hiểm / phụ thu",
  CUSTOMS_TAX: "Thuế, phí thông quan",
  DOMESTIC_SHIPPING: "Chành HN → SG",
  FX_FEE: "Phí chuyển đổi ngoại tệ",
  HANDLING: "Phí xử lý",
  OTHER_LANDED: "Chi phí khác",
};
const SALE_EXPENSE_LABEL: Record<string, string> = {
  SHIPPING_TO_CUSTOMER: "Ship cho khách",
  PLATFORM_FEE: "Phí sàn",
  COD_FEE: "Phí thu hộ",
  GIFT: "Quà tặng",
  OTHER: "Chi phí bán khác",
};

export async function getDebts(db: Db): Promise<Debts> {
  const [sales, refunds, pos, costs, exps] = await Promise.all([
    db<{ id: string; code: string; status: string; customer: string | null; phone: string | null; date: string; total: string; paid: string }[]>`
      WITH tot AS (
        SELECT si.sale_id, SUM(si.price_vnd - si.discount_alloc_vnd) AS total
          FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.status IN ('COMPLETED', 'DEPOSITED')
         WHERE si.voided_at IS NULL GROUP BY si.sale_id
      ), paid AS (
        SELECT t.sale_id, SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END) AS paid
          FROM cash_transactions t JOIN sales s ON s.id = t.sale_id AND s.status IN ('COMPLETED', 'DEPOSITED')
         WHERE t.deleted_at IS NULL GROUP BY t.sale_id
      )
      SELECT s.id::text, s.code, s.status::text, c.full_name AS customer, c.phone, ${db.unsafe(VN_DATE("s.sold_at"))} AS date,
             COALESCE(tot.total, 0)::text AS total, COALESCE(paid.paid, 0)::text AS paid
        FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN tot ON tot.sale_id = s.id LEFT JOIN paid ON paid.sale_id = s.id
       WHERE s.status IN ('COMPLETED', 'DEPOSITED') AND COALESCE(tot.total, 0) - COALESCE(paid.paid, 0) > 0
       ORDER BY s.sold_at`,
    db<{ id: string; kind: string; description: string | null; date: string; amount: string; shipment: string | null; batch: string | null }[]>`
      SELECT c.id::text, c.kind::text, c.description, c.incurred_at::text AS date, (-c.amount_vnd)::text AS amount,
             c.shipment_id::text AS shipment, COALESCE(c.batch_id, po.batch_id, i.batch_id)::text AS batch
        FROM costs c LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id LEFT JOIN items i ON i.id = c.item_id
       WHERE c.deleted_at IS NULL AND c.paid_at IS NULL AND c.amount_vnd < 0 ORDER BY c.incurred_at`,
    db<{ id: string; batch: string; batch_code: string; supplier: string | null; order_number: string | null; date: string; amount: string }[]>`
      SELECT po.id::text, po.batch_id::text AS batch, b.code AS batch_code, sp.name AS supplier, po.order_number,
             ${db.unsafe(VN_DATE("po.ordered_at"))} AS date, po.total_vnd::text AS amount
        FROM purchase_orders po JOIN batches b ON b.id = po.batch_id AND b.deleted_at IS NULL LEFT JOIN suppliers sp ON sp.id = po.supplier_id
       WHERE po.deleted_at IS NULL AND po.paid_at IS NULL AND po.total_vnd > 0 ORDER BY po.ordered_at`,
    db<
      {
        id: string;
        kind: string;
        description: string | null;
        date: string;
        amount: string;
        is_estimate: boolean;
        shipment: string | null;
        batch: string | null;
        batch_code: string | null;
        carrier: string | null;
      }[]
    >`
      SELECT c.id::text, c.kind::text, c.description, c.incurred_at::text AS date, c.amount_vnd::text AS amount, c.is_estimate,
             c.shipment_id::text AS shipment, COALESCE(c.batch_id, po.batch_id, i.batch_id, sh.batch_id)::text AS batch, b.code AS batch_code,
             cr.name AS carrier
        FROM costs c LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id LEFT JOIN items i ON i.id = c.item_id
        LEFT JOIN shipments sh ON sh.id = c.shipment_id LEFT JOIN carriers cr ON cr.id = sh.carrier_id
        LEFT JOIN batches b ON b.id = COALESCE(c.batch_id, po.batch_id, i.batch_id, sh.batch_id)
       WHERE c.deleted_at IS NULL AND c.paid_at IS NULL AND c.amount_vnd > 0 ORDER BY c.incurred_at`,
    db<{ id: string; sale_id: string; code: string; kind: string; date: string; amount: string }[]>`
      SELECT e.id::text, e.sale_id::text, s.code, e.kind, ${db.unsafe(VN_DATE("s.sold_at"))} AS date, e.amount_vnd::text AS amount
        FROM sale_expenses e JOIN sales s ON s.id = e.sale_id AND s.status <> 'CANCELLED'
       WHERE e.paid_at IS NULL ORDER BY s.sold_at`,
  ]);
  const receivables: Receivable[] = [
    ...sales.map((s) => ({
      kind: "SALE" as const,
      id: s.id,
      label: `Đơn bán ${s.code}`,
      party: s.customer,
      phone: s.phone,
      status: s.status,
      date: s.date,
      totalVnd: BigInt(s.total),
      paidVnd: BigInt(s.paid),
      balanceVnd: BigInt(s.total) - BigInt(s.paid),
      href: `/ban-hang/${s.id}`,
    })),
    ...refunds.map((c) => ({
      kind: "COST_REFUND" as const,
      id: c.id,
      label: `Hoàn phí: ${c.description ?? COST_KIND_LABEL[c.kind] ?? c.kind}`,
      party: null,
      phone: null,
      status: null,
      date: c.date,
      totalVnd: BigInt(c.amount),
      paidVnd: 0n,
      balanceVnd: BigInt(c.amount),
      href: c.shipment ? `/van-chuyen/${c.shipment}` : `/chuyen-hang/${c.batch}`,
    })),
  ];
  const payables: Payable[] = [
    ...pos.map((p) => ({
      kind: "PURCHASE_ORDER" as const,
      id: p.id,
      label: `Đơn mua ${p.order_number ?? ""} · ${p.batch_code}`.replace("  ·", " ·"),
      party: p.supplier,
      date: p.date,
      amountVnd: BigInt(p.amount),
      isEstimate: false,
      href: `/chuyen-hang/${p.batch}`,
    })),
    ...costs.map((c) => ({
      kind: "COST" as const,
      id: c.id,
      label: `${COST_KIND_LABEL[c.kind] ?? c.kind}${c.description ? ` — ${c.description}` : ""}${c.batch_code ? ` · ${c.batch_code}` : ""}`,
      party: c.carrier,
      date: c.date,
      amountVnd: BigInt(c.amount),
      isEstimate: c.is_estimate,
      href: c.shipment ? `/van-chuyen/${c.shipment}` : `/chuyen-hang/${c.batch}`,
    })),
    ...exps.map((e) => ({
      kind: "SALE_EXPENSE" as const,
      id: e.id,
      label: `${SALE_EXPENSE_LABEL[e.kind] ?? e.kind} · ${e.code}`,
      party: null,
      date: e.date,
      amountVnd: BigInt(e.amount),
      isEstimate: false,
      href: `/ban-hang/${e.sale_id}`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return {
    receivables,
    payables,
    receivableVnd: receivables.reduce((s, r) => s + r.balanceVnd, 0n),
    payableVnd: payables.reduce((s, p) => s + p.amountVnd, 0n),
  };
}

/** "Đã trả" một khoản phải trả (hoặc "đã nhận" hoàn phí): ghi tài khoản + ngày trả vào chứng từ → sinh bút toán. */
export async function markPaid(db: Db, input: { kind: "PURCHASE_ORDER" | "COST" | "SALE_EXPENSE"; id: string; accountId: string; paidAt: string }) {
  return db.begin(async (tx) => {
    const acc = await accountOf(tx, input.accountId);
    if (!acc.is_active) throw new LedgerError("INVALID_INPUT", "Tài khoản đã ngừng dùng", "accountId");
    const at = noonVn(input.paidAt);
    if (input.kind === "PURCHASE_ORDER") {
      const [r] = await tx`UPDATE purchase_orders SET payment_account_id = ${acc.id}, paid_at = ${at}, updated_at = now()
                            WHERE id = ${input.id} AND deleted_at IS NULL AND paid_at IS NULL RETURNING id`;
      if (!r) throw new LedgerError("NOT_FOUND", "Đơn mua không còn trong danh sách phải trả");
      await syncPurchaseOrderEntry(tx, input.id);
    } else if (input.kind === "COST") {
      const [r] = await tx`UPDATE costs SET account_id = ${acc.id}, paid_at = ${at}, updated_at = now()
                            WHERE id = ${input.id} AND deleted_at IS NULL AND paid_at IS NULL RETURNING id`;
      if (!r) throw new LedgerError("NOT_FOUND", "Khoản chi phí không còn trong danh sách công nợ");
      await syncCostEntry(tx, input.id);
    } else {
      const [r] = await tx`UPDATE sale_expenses SET account_id = ${acc.id}, paid_at = ${at} WHERE id = ${input.id} AND paid_at IS NULL RETURNING id`;
      if (!r) throw new LedgerError("NOT_FOUND", "Chi phí bán hàng không còn trong danh sách phải trả");
      await syncSaleExpenseEntry(tx, input.id);
    }
    await audit(tx, "UPDATE", input.kind.toLowerCase(), input.id, { paidAt: null }, { accountId: acc.id, paidAt: input.paidAt });
  });
}

/** Danh sách tài khoản đang dùng (cho ô chọn). */
export async function accountOptions(db: Db) {
  return db<{ id: string; name: string; currency: Currency }[]>`
    SELECT id::text, name, currency::text AS currency FROM accounts WHERE is_active ORDER BY currency DESC, name`;
}
