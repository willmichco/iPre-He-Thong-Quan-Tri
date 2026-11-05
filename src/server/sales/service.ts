/**
 * Dịch vụ bán hàng & hồ sơ máy (tài liệu 01 mục 6–8, tài liệu 04 mục 4.2).
 *
 * - Bán hoàn tất: máy phải đã về SG (hoặc xác nhận "bán giao thẳng"); máy → "Đã bán", mốc M8, bảo hành shop.
 * - Đặt cọc: máy ở bất kỳ chặng nào trước khi bán → "Khách cọc"; hoàn tất sau khi máy về.
 * - Giá vốn lúc bán được chụp lại (cost_snapshot_vnd); giảm giá & chi phí bán hàng chia theo giá bán từng máy.
 * - Tiền nhận ghi vào sổ thu chi (cash_transactions); huỷ cọc / khách trả lại ghi hoàn tiền.
 * Mọi thao tác ghi audit_logs, chạy trong 1 transaction.
 */
import type { Sql, TransactionSql } from "postgres";
import { variantLabel } from "@/domain/catalog";
import { nextSaleCode, NOT_SELLABLE, statusFromEvents, warrantyUntil, type SaleInput } from "@/domain/sales";
import { recalculateSale } from "@/server/costing/service";

type Db = Sql | TransactionSql;

export type SaleErrorCode = "NOT_FOUND" | "NOT_SELLABLE" | "INVALID_STATE" | "INVALID_INPUT" | "NEEDS_CONFIRM";

export class SaleError extends Error {
  constructor(
    readonly code: SaleErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SaleError";
  }
}

async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", id: string, before: unknown, after: unknown) {
  const json = (v: unknown) => (v == null ? null : tx.json(JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as never));
  await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after) VALUES (${action}, 'sale', ${id}, ${json(before)}, ${json(after)})`;
}

const vnDate = (iso?: string) => new Date(iso ?? Date.now()).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

// ---- Tra máy để bán -------------------------------------------------------------------------------------

export interface SellableItem {
  id: string;
  label: string;
  serial: string | null;
  imei1: string | null;
  status: string;
  batchCode: string;
  costVnd: bigint;
  hasEstimate: boolean;
  targetPriceVnd: bigint | null;
  daysInStock: number | null;
  arrivedSg: boolean;
  /** đơn bán còn hiệu lực đang giữ máy (đã cọc / đã bán) */
  activeSale: { id: string; code: string; status: string } | null;
  /** NOW = bán hoàn tất được · DEPOSIT_ONLY = máy chưa về, chỉ nhận cọc (hoặc bán giao thẳng) · NO = không bán được */
  sellable: "NOW" | "DEPOSIT_ONLY" | "NO";
  reason: string | null;
}

/** Tra máy theo Serial / IMEI (quét hoặc gõ) — kèm giá vốn hiện tại và lý do nếu không bán được. */
export async function findItemForSale(db: Db, code: string): Promise<SellableItem | null> {
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!c) return null;
  const [r] = await db<
    {
      id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      serial_number: string | null;
      imei1: string | null;
      status: string;
      batch_code: string;
      cost: string;
      has_estimate: boolean;
      target: string | null;
      sg_at: string | null;
      days: number | null;
      sale_id: string | null;
      sale_code: string | null;
      sale_status: string | null;
    }[]
  >`
    SELECT i.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity, i.serial_number, i.imei1, i.status::text,
           b.code AS batch_code, lc.landed_cost_vnd::text AS cost, lc.has_estimate, i.target_price_vnd::text AS target,
           ms.sg_received_at::text AS sg_at, FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)::int AS days,
           s.id::text AS sale_id, s.code AS sale_code, s.status::text AS sale_status
      FROM items i
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN batches b ON b.id = i.batch_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
      LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
      LEFT JOIN sale_items si ON si.item_id = i.id AND si.voided_at IS NULL
      LEFT JOIN sales s ON s.id = si.sale_id AND s.status <> 'CANCELLED'
     WHERE i.deleted_at IS NULL AND (i.serial_number = ${c} OR i.imei1 = ${c} OR i.imei2 = ${c})
     ORDER BY s.created_at DESC NULLS LAST
     LIMIT 1`;
  if (!r) return null;
  const arrivedSg = !!r.sg_at;
  const active = r.sale_id && r.sale_code && r.sale_status ? { id: r.sale_id, code: r.sale_code, status: r.sale_status } : null;
  let sellable: SellableItem["sellable"] = arrivedSg ? "NOW" : "DEPOSIT_ONLY";
  let reason: string | null = arrivedSg ? null : "Máy chưa về SG — nhận cọc (đặt trước) hoặc xác nhận bán giao thẳng";
  if ((NOT_SELLABLE as readonly string[]).includes(r.status)) {
    sellable = "NO";
    reason = `Máy đang ở trạng thái không bán được (${r.status})`;
  }
  if (active) {
    sellable = "NO";
    reason = active.status === "DEPOSITED" ? `Khách đã cọc ở đơn ${active.code} — mở đơn đó để hoàn tất` : `Đã bán ở đơn ${active.code}`;
  }
  return {
    id: r.id,
    label: variantLabel(r.model, r),
    serial: r.serial_number,
    imei1: r.imei1,
    status: r.status,
    batchCode: r.batch_code,
    costVnd: BigInt(r.cost),
    hasEstimate: r.has_estimate,
    targetPriceVnd: r.target === null ? null : BigInt(r.target),
    daysInStock: r.days,
    arrivedSg,
    activeSale: active,
    sellable,
    reason,
  };
}

// ---- Tạo đơn bán ----------------------------------------------------------------------------------------

async function lockItems(tx: TransactionSql, ids: string[]) {
  return tx<{ id: string; status: string; serial_number: string | null; imei1: string | null; sg: boolean; cost: string; active: boolean }[]>`
    SELECT i.id::text, i.status::text, i.serial_number, i.imei1,
           EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event_type = 'SG_RECEIVED') AS sg,
           lc.landed_cost_vnd::text AS cost,
           EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                    WHERE si.item_id = i.id AND si.voided_at IS NULL AND s.status <> 'CANCELLED') AS active
      FROM items i JOIN v_item_landed_cost lc ON lc.item_id = i.id
     WHERE i.id = ANY(${ids}::uuid[]) AND i.deleted_at IS NULL
     FOR UPDATE OF i`;
}

async function findOrCreateCustomer(tx: TransactionSql, phone: string, name: string): Promise<string | null> {
  if (!phone && !name) return null;
  if (phone) {
    const norm = phone.replace(/^\+?84/, "0");
    const [c] = await tx<{ id: string; full_name: string }[]>`SELECT id::text, full_name FROM customers WHERE phone = ${norm} AND deleted_at IS NULL LIMIT 1`;
    if (c) {
      if (name && c.full_name !== name && c.full_name.startsWith("Khách ")) await tx`UPDATE customers SET full_name = ${name} WHERE id = ${c.id}`;
      return c.id;
    }
    const [n] = await tx<{ id: string }[]>`INSERT INTO customers (full_name, phone) VALUES (${name || `Khách ${norm.slice(-4)}`}, ${norm}) RETURNING id::text`;
    return n.id;
  }
  const [n] = await tx<{ id: string }[]>`INSERT INTO customers (full_name) VALUES (${name}) RETURNING id::text`;
  return n.id;
}

async function receive(
  tx: TransactionSql,
  saleId: string,
  accountId: string,
  amount: bigint,
  category: "SALE_DEPOSIT" | "SALE_RECEIPT",
  at: string,
  note?: string,
) {
  const [acc] = await tx<{ currency: string }[]>`SELECT currency::text FROM accounts WHERE id = ${accountId}`;
  if (!acc) throw new SaleError("NOT_FOUND", "Không tìm thấy tài khoản nhận tiền", "accountId");
  if (acc.currency !== "VND") throw new SaleError("INVALID_INPUT", "Tài khoản nhận tiền bán hàng phải là tài khoản VND", "accountId");
  await tx`
    INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, sale_id, note)
    VALUES (${accountId}, 'IN', ${amount.toString()}, ${amount.toString()}, ${at}, ${category}, ${saleId}, ${note ?? null})`;
}

export interface CreateSaleResult {
  id: string;
  code: string;
  status: "DEPOSITED" | "COMPLETED";
}

/**
 * Tạo đơn bán. payment = DEPOSIT → đơn "Đã cọc" (máy "Khách cọc"); còn lại → "Hoàn tất" (máy "Đã bán").
 * Chuyển khoản / tiền mặt để trống số tiền = thu đủ.
 */
export async function createSale(db: Db, input: SaleInput, now = new Date()): Promise<CreateSaleResult> {
  return db.begin(async (tx) => {
    const ids = input.lines.map((l) => l.itemId);
    const items = await lockItems(tx, ids);
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      const name = it?.serial_number ?? it?.imei1 ?? id;
      if (!it) throw new SaleError("NOT_FOUND", `Không tìm thấy máy ${id}`, "lines");
      if (it.active) throw new SaleError("NOT_SELLABLE", `Máy ${name} đã có đơn bán / cọc khác`, "lines");
      if ((NOT_SELLABLE as readonly string[]).includes(it.status)) throw new SaleError("NOT_SELLABLE", `Máy ${name} không bán được (${it.status})`, "lines");
    }
    const deposit = input.payment === "DEPOSIT";
    if (!deposit && !input.directShip) {
      const notArrived = items.filter((i) => !i.sg);
      if (notArrived.length)
        throw new SaleError(
          "NEEDS_CONFIRM",
          `Máy ${notArrived.map((i) => i.serial_number ?? i.imei1).join(", ")} chưa về SG — chọn "Cọc" (đặt trước) hoặc tích "Bán giao thẳng"`,
          "directShip",
        );
    }
    // dưới giá vốn → cần xác nhận lần hai
    const below = input.lines.filter((l) => l.price < BigInt(items.find((i) => i.id === l.itemId)!.cost));
    if (below.length && !input.confirmBelowCost && !deposit)
      throw new SaleError("NEEDS_CONFIRM", `Giá bán thấp hơn giá vốn (${below.length} máy) — tích "Xác nhận bán dưới giá vốn" nếu đúng ý`, "confirmBelowCost");

    await tx`SELECT pg_advisory_xact_lock(7340013)`; // cấp mã đơn tuần tự
    const year = Number(vnDate(now.toISOString()).slice(0, 4));
    const code = nextSaleCode(
      year,
      (await tx<{ code: string }[]>`SELECT code FROM sales WHERE code LIKE ${`BH-${year}-%`}`).map((r) => r.code),
    );
    const customerId = await findOrCreateCustomer(tx, input.customerPhone, input.customerName);
    const at = now.toISOString();
    const status = deposit ? "DEPOSITED" : "COMPLETED";
    const [sale] = await tx<{ id: string }[]>`
      INSERT INTO sales (code, customer_id, channel, status, sold_at, discount_vnd, einvoice_no, note)
      VALUES (${code}, ${customerId}, ${input.channel}, ${status}, ${at}, ${input.discount.toString()}, ${input.einvoiceNo}, ${input.note})
      RETURNING id::text`;
    const warranty = deposit ? null : warrantyUntil(vnDate(at), input.warrantyMonths);
    for (const l of input.lines) {
      const it = items.find((i) => i.id === l.itemId)!;
      await tx`
        INSERT INTO sale_items (sale_id, item_id, price_vnd, cost_snapshot_vnd, warranty_until)
        VALUES (${sale.id}, ${l.itemId}, ${l.price.toString()}, ${deposit ? null : it.cost}, ${warranty})`;
      await tx`UPDATE items SET status = ${deposit ? "RESERVED" : "SOLD"}, updated_at = now() WHERE id = ${l.itemId}`;
      await tx`INSERT INTO item_events (item_id, event_type, occurred_at, sale_id) VALUES (${l.itemId}, ${deposit ? "RESERVED" : "SOLD"}, ${at}, ${sale.id})`;
    }
    const expenses: [string, bigint][] = [
      ["SHIPPING_TO_CUSTOMER", input.shippingFee],
      ["OTHER", input.otherFee],
    ];
    for (const [kind, amount] of expenses)
      if (amount > 0n) await tx`INSERT INTO sale_expenses (sale_id, kind, amount_vnd) VALUES (${sale.id}, ${kind}, ${amount.toString()})`;
    const lines = await recalculateSale(tx, sale.id);

    const total = lines.reduce((a, l) => a + l.netRevenueVnd, 0n);
    const paid = input.payment === "UNPAID" ? input.paidAmount : input.paidAmount > 0n ? input.paidAmount : deposit ? 0n : total;
    if (paid > total) throw new SaleError("INVALID_INPUT", `Số tiền nhận (${paid}) lớn hơn tổng đơn (${total})`, "paidAmount");
    if (paid > 0n) await receive(tx, sale.id, input.accountId!, paid, deposit ? "SALE_DEPOSIT" : "SALE_RECEIPT", at);
    // Không ghi tên / SĐT khách vào nhật ký (nhật ký chỉ-thêm, không ẩn danh hoá được) — chỉ ghi mã khách.
    const logged: Record<string, unknown> = { code, ...input, customerId };
    delete logged.customerName;
    delete logged.customerPhone;
    await audit(tx, "CREATE", sale.id, null, logged);
    return { id: sale.id, code, status };
  });
}

// ---- Sau khi tạo đơn ------------------------------------------------------------------------------------

/** Hoàn tất đơn cọc: máy phải đã về SG (hoặc bán giao thẳng); ghi nhận doanh thu tại thời điểm hoàn tất. */
export async function completeSale(
  db: Db,
  saleId: string,
  opts: { directShip?: boolean; warrantyMonths?: number; accountId?: string | null; paidAmount?: bigint } = {},
  now = new Date(),
) {
  return db.begin(async (tx) => {
    const [s] = await tx<{ status: string }[]>`SELECT status::text FROM sales WHERE id = ${saleId} FOR UPDATE`;
    if (!s) throw new SaleError("NOT_FOUND", "Không tìm thấy đơn bán");
    if (s.status !== "DEPOSITED") throw new SaleError("INVALID_STATE", "Chỉ đơn đang cọc mới hoàn tất được");
    const lines = await tx<{ item_id: string }[]>`SELECT item_id::text FROM sale_items WHERE sale_id = ${saleId} AND voided_at IS NULL`;
    const items = await lockItems(
      tx,
      lines.map((l) => l.item_id),
    );
    const notArrived = items.filter((i) => !i.sg);
    if (notArrived.length && !opts.directShip)
      throw new SaleError(
        "NEEDS_CONFIRM",
        `Máy ${notArrived.map((i) => i.serial_number ?? i.imei1).join(", ")} chưa về SG — tích "Bán giao thẳng" nếu giao luôn`,
        "directShip",
      );
    const at = now.toISOString();
    const warranty = warrantyUntil(vnDate(at), opts.warrantyMonths ?? 6);
    await tx`UPDATE sales SET status = 'COMPLETED', sold_at = ${at}, updated_at = now() WHERE id = ${saleId}`;
    for (const it of items) {
      await tx`UPDATE sale_items SET cost_snapshot_vnd = ${it.cost}, warranty_until = ${warranty} WHERE sale_id = ${saleId} AND item_id = ${it.id} AND voided_at IS NULL`;
      await tx`UPDATE items SET status = 'SOLD', updated_at = now() WHERE id = ${it.id}`;
      await tx`INSERT INTO item_events (item_id, event_type, occurred_at, sale_id) VALUES (${it.id}, 'SOLD', ${at}, ${saleId})`;
    }
    if (opts.paidAmount && opts.paidAmount > 0n) {
      if (!opts.accountId) throw new SaleError("INVALID_INPUT", "Chọn tài khoản nhận tiền", "accountId");
      await receive(tx, saleId, opts.accountId, opts.paidAmount, "SALE_RECEIPT", at);
    }
    await audit(tx, "UPDATE", saleId, { status: "DEPOSITED" }, { status: "COMPLETED", directShip: !!opts.directShip });
  });
}

/** Ghi nhận thêm một lần thu tiền (khách trả nốt, trả góp). */
export async function addPayment(db: Db, saleId: string, accountId: string, amount: bigint, now = new Date()) {
  return db.begin(async (tx) => {
    const sale = await getSale(tx, saleId);
    if (!sale) throw new SaleError("NOT_FOUND", "Không tìm thấy đơn bán");
    if (sale.status === "CANCELLED") throw new SaleError("INVALID_STATE", "Đơn đã huỷ");
    if (amount <= 0n) throw new SaleError("INVALID_INPUT", "Số tiền phải > 0", "amount");
    if (amount > sale.balanceVnd) throw new SaleError("INVALID_INPUT", `Khách chỉ còn nợ ${sale.balanceVnd.toLocaleString("vi-VN")} đ`, "amount");
    await receive(tx, saleId, accountId, amount, sale.status === "DEPOSITED" ? "SALE_DEPOSIT" : "SALE_RECEIPT", now.toISOString());
    await audit(tx, "UPDATE", saleId, null, { payment: amount });
  });
}

async function refund(tx: TransactionSql, saleId: string, accountId: string | null, amount: bigint, at: string, note: string) {
  if (amount <= 0n) return;
  if (!accountId) throw new SaleError("INVALID_INPUT", "Chọn tài khoản hoàn tiền", "accountId");
  await tx`
    INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, sale_id, note)
    VALUES (${accountId}, 'OUT', ${amount.toString()}, ${amount.toString()}, ${at}, 'SALE_REFUND', ${saleId}, ${note})`;
}

async function restoreStatus(tx: TransactionSql, itemId: string) {
  const ev = await tx<{ e: string }[]>`SELECT event_type::text AS e FROM item_events WHERE item_id = ${itemId}`;
  await tx`UPDATE items SET status = ${statusFromEvents(ev.map((x) => x.e))}, updated_at = now() WHERE id = ${itemId}`;
}

/** Huỷ đơn cọc: máy về lại trạng thái theo mốc; hoàn cọc (một phần / toàn bộ / giữ cọc). */
export async function cancelDeposit(db: Db, saleId: string, reason: string, refundVnd: bigint, accountId: string | null, now = new Date()) {
  if (reason.trim().length < 3) throw new SaleError("INVALID_INPUT", "Ghi lý do huỷ", "reason");
  return db.begin(async (tx) => {
    const sale = await getSale(tx, saleId);
    if (!sale) throw new SaleError("NOT_FOUND", "Không tìm thấy đơn bán");
    if (sale.status !== "DEPOSITED") throw new SaleError("INVALID_STATE", 'Chỉ huỷ được đơn đang cọc — đơn đã hoàn tất thì dùng "Khách trả lại"');
    if (refundVnd > sale.paidVnd) throw new SaleError("INVALID_INPUT", `Chỉ hoàn tối đa số đã nhận ${sale.paidVnd.toLocaleString("vi-VN")} đ`, "refund");
    const at = now.toISOString();
    await tx`UPDATE sales SET status = 'CANCELLED', updated_at = now(), note = concat_ws(E'\n', note, ${`Huỷ: ${reason.trim()}`}::text) WHERE id = ${saleId}`;
    for (const l of sale.lines) {
      await tx`UPDATE sale_items SET voided_at = ${at}, void_reason = ${reason.trim()} WHERE id = ${l.id}`;
      await tx`INSERT INTO item_events (item_id, event_type, occurred_at, sale_id, note) VALUES (${l.itemId}, 'NOTE', ${at}, ${saleId}, ${`Huỷ cọc: ${reason.trim()}`})`;
      await restoreStatus(tx, l.itemId);
    }
    await refund(tx, saleId, accountId, refundVnd, at, `Hoàn cọc: ${reason.trim()}`);
    await audit(tx, "UPDATE", saleId, { status: "DEPOSITED" }, { status: "CANCELLED", reason, refund: refundVnd });
  });
}

/** Khách trả lại một máy của đơn đã hoàn tất: huỷ dòng bán, máy về tồn kho, ghi hoàn tiền; lịch sử giữ nguyên. */
export async function returnItem(db: Db, saleItemId: string, reason: string, refundVnd: bigint, accountId: string | null, now = new Date()) {
  if (reason.trim().length < 3) throw new SaleError("INVALID_INPUT", "Ghi lý do trả lại", "reason");
  return db.begin(async (tx) => {
    const [l] = await tx<{ sale_id: string; item_id: string; status: string }[]>`
      SELECT si.sale_id::text, si.item_id::text, s.status::text FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE si.id = ${saleItemId} AND si.voided_at IS NULL FOR UPDATE OF si`;
    if (!l) throw new SaleError("NOT_FOUND", "Không tìm thấy dòng bán còn hiệu lực");
    if (l.status !== "COMPLETED") throw new SaleError("INVALID_STATE", 'Đơn chưa hoàn tất — dùng "Huỷ cọc"');
    const at = now.toISOString();
    await tx`UPDATE sale_items SET voided_at = ${at}, void_reason = ${reason.trim()} WHERE id = ${saleItemId}`;
    await tx`INSERT INTO item_events (item_id, event_type, occurred_at, sale_id, note) VALUES (${l.item_id}, 'RETURNED_BY_CUSTOMER', ${at}, ${l.sale_id}, ${reason.trim()})`;
    await tx`UPDATE items SET status = 'IN_STOCK', updated_at = now() WHERE id = ${l.item_id}`;
    // giảm giá & chi phí của đơn chia lại cho các máy còn lại
    await recalculateSale(tx, l.sale_id);
    const [left] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sale_items WHERE sale_id = ${l.sale_id} AND voided_at IS NULL`;
    if (!left.n) await tx`UPDATE sales SET status = 'CANCELLED', updated_at = now() WHERE id = ${l.sale_id}`;
    await refund(tx, l.sale_id, accountId, refundVnd, at, `Khách trả lại: ${reason.trim()}`);
    await audit(tx, "UPDATE", l.sale_id, null, { returnedItem: l.item_id, reason, refund: refundVnd });
  });
}

/** Ghi / sửa số hoá đơn điện tử của đơn (trống = chưa xuất). Phục vụ sổ doanh thu thuế. */
export async function setEinvoiceNo(db: Db, saleId: string, raw: string) {
  const no = raw.trim().slice(0, 60) || null;
  return db.begin(async (tx) => {
    const [s] = await tx<{ einvoice_no: string | null; status: string }[]>`SELECT einvoice_no, status::text FROM sales WHERE id = ${saleId} FOR UPDATE`;
    if (!s) throw new SaleError("NOT_FOUND", "Không tìm thấy đơn bán");
    if (s.status === "CANCELLED" && no) throw new SaleError("INVALID_STATE", "Đơn đã huỷ — không ghi hoá đơn", "einvoiceNo");
    await tx`UPDATE sales SET einvoice_no = ${no}, updated_at = now() WHERE id = ${saleId}`;
    await audit(tx, "UPDATE", saleId, { einvoiceNo: s.einvoice_no }, { einvoiceNo: no });
  });
}

// ---- Đọc ------------------------------------------------------------------------------------------------

export interface SaleDetail {
  id: string;
  code: string;
  status: string;
  channel: string;
  soldAt: string;
  customer: { id: string; name: string; phone: string | null } | null;
  discountVnd: bigint;
  einvoiceNo: string | null;
  note: string | null;
  lines: {
    id: string;
    itemId: string;
    label: string;
    serial: string | null;
    imei1: string | null;
    priceVnd: bigint;
    discountAllocVnd: bigint;
    expenseAllocVnd: bigint;
    costVnd: bigint;
    costSnapshotVnd: bigint | null;
    hasEstimate: boolean;
    warrantyUntil: string | null;
    voidedAt: string | null;
    voidReason: string | null;
  }[];
  expenses: { kind: string; amountVnd: bigint }[];
  payments: { id: string; direction: "IN" | "OUT"; amountVnd: bigint; at: string; category: string; account: string; note: string | null }[];
  /** doanh thu thuần của các dòng còn hiệu lực */
  totalVnd: bigint;
  paidVnd: bigint;
  balanceVnd: bigint;
}

export async function getSale(db: Db, id: string): Promise<SaleDetail | null> {
  const [s] = await db<
    {
      id: string;
      code: string;
      status: string;
      channel: string;
      sold_at: string;
      cid: string | null;
      cname: string | null;
      phone: string | null;
      discount: string;
      einvoice_no: string | null;
      note: string | null;
    }[]
  >`
    SELECT s.id::text, s.code, s.status::text, s.channel, s.sold_at::text, c.id::text AS cid, c.full_name AS cname, c.phone,
           s.discount_vnd::text AS discount, s.einvoice_no, s.note
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ${id}`;
  if (!s) return null;
  const lines = await db<
    {
      id: string;
      item_id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      serial_number: string | null;
      imei1: string | null;
      price: string;
      disc: string;
      exp: string;
      cost: string;
      snap: string | null;
      has_estimate: boolean;
      warranty: string | null;
      voided_at: string | null;
      void_reason: string | null;
    }[]
  >`
    SELECT si.id::text, si.item_id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity, i.serial_number, i.imei1,
           si.price_vnd::text AS price, si.discount_alloc_vnd::text AS disc, si.expense_alloc_vnd::text AS exp,
           lc.landed_cost_vnd::text AS cost, si.cost_snapshot_vnd::text AS snap, lc.has_estimate, si.warranty_until::text AS warranty,
           si.voided_at::text, si.void_reason
      FROM sale_items si JOIN items i ON i.id = si.item_id
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN v_item_landed_cost lc ON lc.item_id = i.id
     WHERE si.sale_id = ${id} ORDER BY si.voided_at NULLS FIRST, si.price_vnd DESC, si.id`;
  const expenses = await db<{ kind: string; amount: string }[]>`SELECT kind, amount_vnd::text AS amount FROM sale_expenses WHERE sale_id = ${id} ORDER BY kind`;
  const payments = await db<{ id: string; direction: "IN" | "OUT"; amount: string; at: string; category: string; account: string; note: string | null }[]>`
    SELECT t.id::text, t.direction::text AS direction, t.amount_vnd::text AS amount, t.occurred_at::text AS at, t.category_code AS category,
           a.name AS account, t.note
      FROM cash_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.sale_id = ${id} AND t.deleted_at IS NULL ORDER BY t.occurred_at, t.created_at`;
  const mapped = lines.map((l) => ({
    id: l.id,
    itemId: l.item_id,
    label: variantLabel(l.model, l),
    serial: l.serial_number,
    imei1: l.imei1,
    priceVnd: BigInt(l.price),
    discountAllocVnd: BigInt(l.disc),
    expenseAllocVnd: BigInt(l.exp),
    costVnd: BigInt(l.cost),
    costSnapshotVnd: l.snap === null ? null : BigInt(l.snap),
    hasEstimate: l.has_estimate,
    warrantyUntil: l.warranty,
    voidedAt: l.voided_at,
    voidReason: l.void_reason,
  }));
  const total = mapped.filter((l) => !l.voidedAt).reduce((a, l) => a + l.priceVnd - l.discountAllocVnd, 0n);
  const pays = payments.map((p) => ({ ...p, amountVnd: BigInt(p.amount) }));
  const paid = pays.reduce((a, p) => a + (p.direction === "IN" ? p.amountVnd : -p.amountVnd), 0n);
  return {
    id: s.id,
    code: s.code,
    status: s.status,
    channel: s.channel,
    soldAt: s.sold_at,
    customer: s.cid ? { id: s.cid, name: s.cname!, phone: s.phone } : null,
    discountVnd: BigInt(s.discount),
    einvoiceNo: s.einvoice_no,
    note: s.note,
    lines: mapped,
    expenses: expenses.map((e) => ({ kind: e.kind, amountVnd: BigInt(e.amount) })),
    payments: pays.map(({ amount: _a, ...p }) => (void _a, p)),
    totalVnd: total,
    paidVnd: paid,
    balanceVnd: s.status === "CANCELLED" ? 0n : total - paid,
  };
}

export interface SaleListRow {
  id: string;
  code: string;
  status: string;
  soldAt: string;
  customer: string | null;
  itemCount: number;
  revenueVnd: bigint;
  profitVnd: bigint | null;
  balanceVnd: bigint;
}

export async function listSales(db: Db, limit = 100): Promise<SaleListRow[]> {
  const rows = await db<
    { id: string; code: string; status: string; sold_at: string; customer: string | null; n: number; revenue: string; profit: string | null; paid: string }[]
  >`
    SELECT s.id::text, s.code, s.status::text, s.sold_at::text, c.full_name AS customer,
           (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL) AS n,
           (SELECT COALESCE(SUM(si.price_vnd - si.discount_alloc_vnd), 0)::text FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL) AS revenue,
           (SELECT SUM(p.profit_vnd)::text FROM v_sale_item_profit p WHERE p.sale_id = s.id) AS profit,
           (SELECT COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END), 0)::text
              FROM cash_transactions t WHERE t.sale_id = s.id AND t.deleted_at IS NULL) AS paid
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     ORDER BY s.sold_at DESC, s.code DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    soldAt: r.sold_at,
    customer: r.customer,
    itemCount: r.n,
    revenueVnd: BigInt(r.revenue),
    profitVnd: r.profit === null ? null : BigInt(r.profit),
    balanceVnd: r.status === "CANCELLED" ? 0n : BigInt(r.revenue) - BigInt(r.paid),
  }));
}

// ---- Hồ sơ máy ------------------------------------------------------------------------------------------

export async function getItemProfile(db: Db, itemId: string) {
  const [i] = await db<
    {
      id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      sku: string;
      serial_number: string | null;
      imei1: string | null;
      imei2: string | null;
      part_number: string | null;
      condition: string;
      status: string;
      unit_price: string;
      currency: string;
      fx_rate: string;
      batch_id: string;
      batch_code: string;
      batch_status: string;
      supplier: string;
      order_number: string | null;
      note: string | null;
    }[]
  >`
    SELECT i.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity, v.sku, i.serial_number, i.imei1, i.imei2,
           i.part_number, i.condition::text, i.status::text, i.unit_price::text, po.currency::text AS currency, po.fx_rate::text,
           b.id::text AS batch_id, b.code AS batch_code, b.status::text AS batch_status, s.name AS supplier, po.order_number, i.note
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN batches b ON b.id = i.batch_id JOIN purchase_orders po ON po.id = i.purchase_order_id JOIN suppliers s ON s.id = po.supplier_id
     WHERE i.id = ${itemId}`;
  if (!i) return null;
  const events = await db<{ type: string; at: string; tracking: string | null; leg: string | null; sale_code: string | null; note: string | null }[]>`
    SELECT e.event_type::text AS type, e.occurred_at::text AS at, COALESCE(sh.tracking_number, sh.reference_code) AS tracking,
           sh.leg_type::text AS leg, s.code AS sale_code, e.note
      FROM item_events e LEFT JOIN shipments sh ON sh.id = e.shipment_id LEFT JOIN sales s ON s.id = e.sale_id
     WHERE e.item_id = ${itemId} ORDER BY e.occurred_at, e.created_at`;
  const components = await db<{ component: string; amount: string; is_estimate: boolean; description: string | null; cost_id: string | null }[]>`
    SELECT a.component, a.amount_vnd::text AS amount, a.is_estimate, c.description, a.cost_id::text
      FROM item_cost_allocations a LEFT JOIN costs c ON c.id = a.cost_id
     WHERE a.item_id = ${itemId}
     ORDER BY array_position(ARRAY['PRICE','SALES_TAX','SELLER_SHIPPING','DISCOUNT','PO_FX_FEE','US_DOMESTIC_SHIPPING','INTL_SHIPPING','INSURANCE',
                                   'CUSTOMS_TAX','DOMESTIC_SHIPPING','FX_FEE','HANDLING','OTHER_LANDED'], a.component)`;
  const sales = await db<
    { sale_id: string; code: string; status: string; price: string; warranty: string | null; voided_at: string | null; profit: string | null }[]
  >`
    SELECT s.id::text AS sale_id, s.code, s.status::text, si.price_vnd::text AS price, si.warranty_until::text AS warranty, si.voided_at::text,
           (SELECT p.profit_vnd::text FROM v_sale_item_profit p WHERE p.sale_item_id = si.id) AS profit
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.item_id = ${itemId} ORDER BY s.sold_at`;
  return {
    id: i.id,
    label: variantLabel(i.model, i),
    sku: i.sku,
    serial: i.serial_number,
    imei1: i.imei1,
    imei2: i.imei2,
    partNumber: i.part_number,
    condition: i.condition,
    status: i.status,
    unitPrice: i.unit_price,
    currency: i.currency,
    fxRate: i.fx_rate,
    batch: { id: i.batch_id, code: i.batch_code, status: i.batch_status },
    supplier: i.supplier,
    orderNumber: i.order_number,
    note: i.note,
    events,
    components: components.map((c) => ({ component: c.component, amountVnd: BigInt(c.amount), isEstimate: c.is_estimate, description: c.description })),
    landedCostVnd: components.reduce((a, c) => a + BigInt(c.amount), 0n),
    sales: sales.map((s) => ({ ...s, priceVnd: BigInt(s.price), profitVnd: s.profit === null ? null : BigInt(s.profit) })),
  };
}

/** Tìm máy theo Serial / IMEI / Part No. (ô tìm kiếm kho). */
export async function searchItems(db: Db, q: string, limit = 50) {
  const c = q.trim().toUpperCase();
  return db<
    { id: string; label: string; serial_number: string | null; imei1: string | null; status: string; batch_code: string; cost: string; days: number | null }[]
  >`
    SELECT i.id::text, m.name || COALESCE(' · ' || v.storage, '') || COALESCE(' · ' || v.color, '') AS label, i.serial_number, i.imei1,
           i.status::text, b.code AS batch_code, lc.landed_cost_vnd::text AS cost,
           FLOOR(EXTRACT(EPOCH FROM (now() - ms.sg_received_at)) / 86400)::int AS days
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN batches b ON b.id = i.batch_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
      LEFT JOIN v_item_milestones ms ON ms.item_id = i.id
     WHERE i.deleted_at IS NULL
       AND (${c} = '' AND i.status IN ('IN_STOCK', 'RESERVED')
            OR ${c} <> '' AND (i.serial_number LIKE ${`%${c}%`} OR i.imei1 LIKE ${`%${c}%`} OR i.imei2 LIKE ${`%${c}%`} OR i.part_number = ${c}
                               OR upper(m.name) LIKE ${`%${c}%`}))
     ORDER BY ms.sg_received_at NULLS LAST, i.created_at
     LIMIT ${limit}`;
}
