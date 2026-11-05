/**
 * Khách hàng: danh sách kèm số liệu mua hàng / công nợ, hồ sơ một khách (đơn, máy đã mua, bảo hành), sửa thông tin,
 * ẩn danh hoá theo yêu cầu. Nhật ký thay đổi KHÔNG lưu lại thông tin cá nhân cũ (chỉ ghi trường nào đổi).
 */
import type { Sql, TransactionSql } from "postgres";
import { anonymousName, type CustomerInput } from "@/domain/customers";
import { variantLabel } from "@/domain/catalog";

type Db = Sql | TransactionSql;

export class CustomerError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_INPUT" | "DUPLICATE",
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CustomerError";
  }
}

export interface CustomerRow {
  id: string;
  fullName: string;
  phone: string | null;
  orders: number;
  revenueVnd: bigint;
  balanceVnd: bigint;
  lastPurchase: string | null;
}

/** Tổng hợp đơn của từng khách: doanh thu (đơn hoàn tất), còn nợ (đơn hoàn tất / đang cọc), lần mua gần nhất. */
const STATS = (db: Db) => db`
  WITH tot AS (
    SELECT s.customer_id, s.id, s.status, s.sold_at,
           COALESCE((SELECT SUM(si.price_vnd - si.discount_alloc_vnd) FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL), 0) AS total,
           COALESCE((SELECT SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END)
                       FROM cash_transactions t WHERE t.sale_id = s.id AND t.deleted_at IS NULL), 0) AS paid
      FROM sales s WHERE s.customer_id IS NOT NULL AND s.status <> 'CANCELLED'
  ), agg AS (
    SELECT customer_id, COUNT(*)::int AS orders,
           COALESCE(SUM(total) FILTER (WHERE status = 'COMPLETED'), 0) AS revenue,
           COALESCE(SUM(GREATEST(total - paid, 0)), 0) AS balance,
           MAX(sold_at) AS last_at
      FROM tot GROUP BY customer_id
  )`;

export async function listCustomers(db: Db, q = "", limit = 200): Promise<CustomerRow[]> {
  const term = q.trim();
  const digits = term.replace(/\D/g, "");
  const rows = await db<
    { id: string; full_name: string; phone: string | null; orders: number | null; revenue: string | null; balance: string | null; last: string | null }[]
  >`
    ${STATS(db)}
    SELECT c.id::text, c.full_name, c.phone, agg.orders, agg.revenue::text, agg.balance::text,
           to_char(agg.last_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS last
      FROM customers c LEFT JOIN agg ON agg.customer_id = c.id
     WHERE c.deleted_at IS NULL
       ${term ? db`AND (c.full_name ILIKE ${`%${term}%`} ${digits.length >= 3 ? db`OR c.phone LIKE ${`%${digits}%`}` : db``} OR c.zalo ILIKE ${`%${term}%`})` : db``}
     ORDER BY agg.last_at DESC NULLS LAST, c.created_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    orders: r.orders ?? 0,
    revenueVnd: BigInt(r.revenue ?? "0"),
    balanceVnd: BigInt(r.balance ?? "0"),
    lastPurchase: r.last,
  }));
}

export async function getCustomer(db: Db, id: string) {
  const [c] = await db<
    {
      id: string;
      full_name: string;
      phone: string | null;
      zalo: string | null;
      facebook: string | null;
      address: string | null;
      note: string | null;
      created_at: string;
      anonymized: boolean;
    }[]
  >`
    SELECT id::text, full_name, phone, zalo, facebook, address, note, to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS created_at,
           deleted_at IS NOT NULL AS anonymized
      FROM customers WHERE id = ${id}`;
  if (!c) return null;
  const [sales, items] = await Promise.all([
    db<{ id: string; code: string; status: string; date: string; total: string; paid: string; einvoice: string | null }[]>`
      SELECT s.id::text, s.code, s.status::text, to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS date,
             COALESCE((SELECT SUM(si.price_vnd - si.discount_alloc_vnd) FROM sale_items si WHERE si.sale_id = s.id AND si.voided_at IS NULL), 0)::text AS total,
             COALESCE((SELECT SUM(CASE WHEN t.direction = 'IN' THEN t.amount_vnd ELSE -t.amount_vnd END)
                         FROM cash_transactions t WHERE t.sale_id = s.id AND t.deleted_at IS NULL), 0)::text AS paid,
             s.einvoice_no AS einvoice
        FROM sales s WHERE s.customer_id = ${id} ORDER BY s.sold_at DESC`,
    db<
      {
        item_id: string;
        sale_id: string;
        code: string;
        model: string;
        storage: string | null;
        color: string | null;
        chip: string | null;
        memory: string | null;
        connectivity: string | null;
        serial: string | null;
        imei1: string | null;
        price: string;
        warranty: string | null;
        voided: boolean;
      }[]
    >`
      SELECT si.item_id::text, s.id::text AS sale_id, s.code, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity,
             i.serial_number AS serial, i.imei1, si.price_vnd::text AS price, si.warranty_until::text AS warranty, si.voided_at IS NOT NULL AS voided
        FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN items i ON i.id = si.item_id
        JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
       WHERE s.customer_id = ${id} ORDER BY s.sold_at DESC, si.id`,
  ]);
  const mappedSales = sales.map((s) => {
    const total = BigInt(s.total);
    const paid = BigInt(s.paid);
    return {
      id: s.id,
      code: s.code,
      status: s.status,
      date: s.date,
      totalVnd: total,
      paidVnd: paid,
      balanceVnd: s.status === "CANCELLED" ? 0n : total - paid,
      einvoiceNo: s.einvoice,
    };
  });
  return {
    id: c.id,
    fullName: c.full_name,
    phone: c.phone,
    zalo: c.zalo,
    facebook: c.facebook,
    address: c.address,
    note: c.note,
    createdAt: c.created_at,
    anonymized: c.anonymized,
    sales: mappedSales,
    items: items.map((i) => ({
      itemId: i.item_id,
      saleId: i.sale_id,
      saleCode: i.code,
      label: variantLabel(i.model, i),
      serial: i.serial,
      imei1: i.imei1,
      priceVnd: BigInt(i.price),
      warrantyUntil: i.warranty,
      returned: i.voided,
    })),
    revenueVnd: mappedSales.filter((s) => s.status === "COMPLETED").reduce((a, s) => a + s.totalVnd, 0n),
    balanceVnd: mappedSales.reduce((a, s) => a + (s.balanceVnd > 0n ? s.balanceVnd : 0n), 0n),
  };
}

/** Thêm (id = null) / sửa khách. Số điện thoại không trùng với khách khác đang hoạt động. */
export async function saveCustomer(db: Db, id: string | null, input: CustomerInput): Promise<string> {
  return db.begin(async (tx) => {
    if (input.phone) {
      const [dup] = await tx<{ id: string; full_name: string }[]>`
        SELECT id::text, full_name FROM customers WHERE phone = ${input.phone} AND deleted_at IS NULL AND id IS DISTINCT FROM ${id}::uuid LIMIT 1`;
      if (dup) throw new CustomerError("DUPLICATE", `Số điện thoại đã thuộc khách "${dup.full_name}"`, "phone");
    }
    const values = { full_name: input.fullName, phone: input.phone, zalo: input.zalo, facebook: input.facebook, address: input.address, note: input.note };
    if (!id) {
      const [r] = await tx<{ id: string }[]>`INSERT INTO customers ${tx(values)} RETURNING id::text`;
      await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after) VALUES ('CREATE', 'customer', ${r.id}, ${tx.json({ fields: Object.keys(values) })})`;
      return r.id;
    }
    const [cur] = await tx<Record<string, string | null>[]>`
      SELECT full_name, phone, zalo, facebook, address, note FROM customers WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!cur) throw new CustomerError("NOT_FOUND", "Không tìm thấy khách (hoặc đã ẩn danh)");
    await tx`UPDATE customers SET ${tx(values)} WHERE id = ${id}`;
    const changed = Object.entries(values)
      .filter(([k, v]) => cur[k] !== v)
      .map(([k]) => k);
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after) VALUES ('UPDATE', 'customer', ${id}, ${tx.json({ changed })})`;
    return id;
  });
}

/**
 * Ẩn danh hoá theo yêu cầu của khách: xoá tên, số điện thoại, Zalo, Facebook, địa chỉ, ghi chú; giữ các đơn bán
 * (nghĩa vụ lưu sổ sách thuế) gắn với mã khách đã ẩn danh. Không hoàn tác được.
 */
export async function anonymizeCustomer(db: Db, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 5) throw new CustomerError("INVALID_INPUT", "Ghi lý do / căn cứ yêu cầu (ít nhất 5 ký tự)", "reason");
  return db.begin(async (tx) => {
    const [c] = await tx`SELECT 1 FROM customers WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!c) throw new CustomerError("NOT_FOUND", "Không tìm thấy khách (hoặc đã ẩn danh)");
    await tx`
      UPDATE customers SET full_name = ${anonymousName(id)}, phone = NULL, zalo = NULL, facebook = NULL, address = NULL, note = NULL, deleted_at = now()
       WHERE id = ${id}`;
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after) VALUES ('DELETE', 'customer', ${id}, ${tx.json({ anonymized: true, reason: why })})`;
  });
}
