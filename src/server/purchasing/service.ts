/**
 * Dịch vụ Chuyến hàng · Đơn mua · Máy. Mọi thao tác làm đổi giá vốn (đơn mua, máy) chạy trong MỘT transaction
 * cùng với bước tính lại giá vốn (src/server/costing/service.ts): chuyến đã chốt → BATCH_FINALIZED, huỷ cả khối.
 * Mọi thao tác ghi đều ghi audit_logs.
 *
 * Không import "server-only" để kiểm thử tích hợp dùng được; chỉ nhận kết nối CSDL qua tham số.
 */
import type { Sql, TransactionSql } from "postgres";
import { variantLabel } from "@/domain/catalog";
import {
  nextBatchCode,
  returnDeadlineFrom,
  validateGrid,
  type BatchInput,
  type CleanItem,
  type GridRow,
  type PurchaseOrderInput,
  type RowIssue,
  type VariantRef,
} from "@/domain/purchasing";
import { recalculateBatch, type RecalcResult } from "@/server/costing/service";

type Db = Sql | TransactionSql;

export type PurchasingErrorCode = "NOT_FOUND" | "DUPLICATE" | "IN_USE" | "INVALID_ROWS";

export class PurchasingError extends Error {
  constructor(
    readonly code: PurchasingErrorCode,
    message: string,
    readonly field?: string,
    /** lỗi theo từng dòng của lưới nhập máy */
    readonly rowIssues: RowIssue[] = [],
  ) {
    super(message);
    this.name = "PurchasingError";
  }
}

async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, id: string, before: unknown, after: unknown) {
  await tx`
    INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
    VALUES (${action}, ${entityType}, ${id}, ${before == null ? null : tx.json(before as never)}, ${after == null ? null : tx.json(after as never)})`;
}

/** Ngày (YYYY-MM-DD) người dùng chọn → thời điểm 12:00 giờ Việt Nam (tránh lệch ngày khi đổi múi giờ). */
const noonVn = (d: string) => `${d}T12:00:00+07:00`;

// ---- Đọc ------------------------------------------------------------------------------------------------

export interface BatchListRow {
  id: string;
  code: string;
  name: string | null;
  status: string;
  createdAt: string;
  itemCount: number;
  soldCount: number;
  orderCount: number;
  totalLandedCostVnd: bigint;
  revenueVnd: bigint;
  realizedProfitVnd: bigint;
  unsoldCostVnd: bigint;
  roiOnSoldPct: string | null;
}

export async function listBatches(db: Db, onlyId?: string): Promise<BatchListRow[]> {
  // Cùng số liệu với v_batch_summary nhưng gom một lượt (hash) cho các máy cần thiết — nhanh hơn nhiều khi có
  // hàng nghìn máy; onlyId: chỉ một chuyến (trang chi tiết). Kiểm thử tích hợp đối chiếu với v_batch_summary.
  const one = onlyId ?? null;
  const rows = await db<
    {
      id: string;
      code: string;
      name: string | null;
      status: string;
      created_at: string;
      item_count: number;
      sold_count: number;
      po_count: number;
      total: string;
      revenue: string;
      profit: string;
      unsold: string;
      roi: string | null;
    }[]
  >`
    WITH bs AS MATERIALIZED (
      SELECT b.id, b.code, b.name, b.status, b.created_at FROM batches b
       WHERE b.deleted_at IS NULL AND (${one}::uuid IS NULL OR b.id = ${one}::uuid)
    ), it AS MATERIALIZED (
      SELECT i.id, i.batch_id FROM items i JOIN bs ON bs.id = i.batch_id WHERE i.deleted_at IS NULL
    ), lc AS MATERIALIZED (
      SELECT a.item_id, SUM(a.amount_vnd) AS landed FROM item_cost_allocations a JOIN it ON it.id = a.item_id GROUP BY a.item_id
    ), sold AS MATERIALIZED (
      SELECT si.item_id, si.price_vnd - si.discount_alloc_vnd AS net, si.expense_alloc_vnd AS expense
        FROM sale_items si JOIN it ON it.id = si.item_id JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
       WHERE si.voided_at IS NULL
    ), per AS (
      SELECT it.batch_id, COUNT(*) AS item_count, COUNT(sold.item_id) AS sold_count,
             SUM(COALESCE(lc.landed, 0)) AS total, SUM(sold.net) AS revenue,
             SUM(COALESCE(lc.landed, 0)) FILTER (WHERE sold.item_id IS NOT NULL) AS cogs,
             SUM(sold.net - COALESCE(lc.landed, 0) - sold.expense) AS profit,
             SUM(COALESCE(lc.landed, 0)) FILTER (WHERE sold.item_id IS NULL) AS unsold
        FROM it LEFT JOIN lc ON lc.item_id = it.id LEFT JOIN sold ON sold.item_id = it.id
       GROUP BY it.batch_id
    )
    SELECT bs.id::text, bs.code, bs.name, bs.status::text, bs.created_at::text,
           COALESCE(per.item_count, 0)::int AS item_count, COALESCE(per.sold_count, 0)::int AS sold_count,
           (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.batch_id = bs.id AND po.deleted_at IS NULL) AS po_count,
           COALESCE(per.total, 0)::bigint::text AS total, COALESCE(per.revenue, 0)::bigint::text AS revenue,
           COALESCE(per.profit, 0)::bigint::text AS profit, COALESCE(per.unsold, 0)::bigint::text AS unsold,
           CASE WHEN per.cogs > 0 THEN ROUND(100.0 * per.profit / per.cogs, 2) END::text AS roi
      FROM bs LEFT JOIN per ON per.batch_id = bs.id
     ORDER BY bs.created_at DESC, bs.code DESC`;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    itemCount: r.item_count,
    soldCount: r.sold_count,
    orderCount: r.po_count,
    totalLandedCostVnd: BigInt(r.total),
    revenueVnd: BigInt(r.revenue),
    realizedProfitVnd: BigInt(r.profit),
    unsoldCostVnd: BigInt(r.unsold),
    roiOnSoldPct: r.roi,
  }));
}

export interface ItemRow {
  id: string;
  purchaseOrderId: string;
  variantId: string;
  variantLabel: string;
  status: string;
  unitPrice: string;
  serial: string | null;
  imei1: string | null;
  imei2: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  condition: string;
  weightKg: string | null;
  note: string | null;
  landedCostVnd: bigint;
  hasEstimate: boolean;
  /** đã vào kiện / đã bán → không xoá được khỏi đơn */
  locked: boolean;
}

export interface PurchaseOrderRow {
  id: string;
  supplierId: string;
  supplierName: string;
  orderNumber: string | null;
  orderedAt: string;
  currency: "USD" | "VND";
  subtotal: string;
  salesTax: string;
  sellerShipping: string;
  discount: string;
  fxRate: string;
  fxFeeVnd: string;
  totalVnd: bigint;
  paymentAccountId: string | null;
  paidAt: string | null;
  returnDeadline: string | null;
  note: string | null;
  items: ItemRow[];
}

export interface BatchDetail {
  id: string;
  code: string;
  name: string | null;
  status: string;
  plannedFxRate: string | null;
  note: string | null;
  costsFinalizedAt: string | null;
  summary: BatchListRow;
  orders: PurchaseOrderRow[];
}

export async function getBatch(db: Db, id: string): Promise<BatchDetail | null> {
  const [b] = await db<{ id: string; code: string; name: string | null; status: string; fx: string | null; note: string | null; fin: string | null }[]>`
    SELECT id::text, code, name, status::text, planned_fx_rate::text AS fx, note, costs_finalized_at::text AS fin FROM batches WHERE id = ${id} AND deleted_at IS NULL`;
  if (!b) return null;
  const [summary] = await listBatches(db, id);
  const pos = await db<
    {
      id: string;
      supplier_id: string;
      supplier: string;
      order_number: string | null;
      ordered_at: string;
      currency: "USD" | "VND";
      subtotal: string;
      sales_tax: string;
      seller_shipping: string;
      discount: string;
      fx_rate: string;
      fx_fee_vnd: string;
      total_vnd: string;
      payment_account_id: string | null;
      paid_at: string | null;
      return_deadline: string | null;
      note: string | null;
    }[]
  >`
    SELECT po.id::text, po.supplier_id::text, s.name AS supplier, po.order_number,
           to_char(po.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ordered_at, po.currency::text AS currency,
           po.subtotal::text, po.sales_tax::text, po.seller_shipping::text, po.discount::text, po.fx_rate::text,
           po.fx_fee_vnd::text, po.total_vnd::text, po.payment_account_id::text,
           to_char(po.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS paid_at, po.return_deadline::text, po.note
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.batch_id = ${id} AND po.deleted_at IS NULL
     ORDER BY po.ordered_at, po.created_at`;
  const items = await db<
    {
      id: string;
      po_id: string;
      variant_id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      status: string;
      unit_price: string;
      serial_number: string | null;
      imei1: string | null;
      imei2: string | null;
      part_number: string | null;
      model_number: string | null;
      condition: string;
      weight_kg: string | null;
      note: string | null;
      landed: string;
      has_estimate: boolean;
      locked: boolean;
    }[]
  >`
    SELECT i.id::text, i.purchase_order_id::text AS po_id, i.variant_id::text, m.name AS model, v.storage, v.color, v.chip, v.memory,
           v.connectivity, i.status::text, i.unit_price::text, i.serial_number, i.imei1, i.imei2, i.part_number, i.model_number,
           i.condition::text, i.weight_kg::text, i.note, lc.landed_cost_vnd::text AS landed, lc.has_estimate,
           (EXISTS (SELECT 1 FROM shipment_items si WHERE si.item_id = i.id)
             OR EXISTS (SELECT 1 FROM sale_items x WHERE x.item_id = i.id AND x.voided_at IS NULL)) AS locked
      FROM items i
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN v_item_landed_cost lc ON lc.item_id = i.id
     WHERE i.batch_id = ${id} AND i.deleted_at IS NULL
     ORDER BY i.created_at, i.id`;
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    status: b.status,
    plannedFxRate: b.fx,
    note: b.note,
    costsFinalizedAt: b.fin,
    summary,
    orders: pos.map((p) => ({
      id: p.id,
      supplierId: p.supplier_id,
      supplierName: p.supplier,
      orderNumber: p.order_number,
      orderedAt: p.ordered_at,
      currency: p.currency,
      subtotal: p.subtotal,
      salesTax: p.sales_tax,
      sellerShipping: p.seller_shipping,
      discount: p.discount,
      fxRate: p.fx_rate,
      fxFeeVnd: p.fx_fee_vnd,
      totalVnd: BigInt(p.total_vnd),
      paymentAccountId: p.payment_account_id,
      paidAt: p.paid_at,
      returnDeadline: p.return_deadline,
      note: p.note,
      items: items
        .filter((i) => i.po_id === p.id)
        .map((i) => ({
          id: i.id,
          purchaseOrderId: i.po_id,
          variantId: i.variant_id,
          variantLabel: variantLabel(i.model, i),
          status: i.status,
          unitPrice: i.unit_price,
          serial: i.serial_number,
          imei1: i.imei1,
          imei2: i.imei2,
          partNumber: i.part_number,
          modelNumber: i.model_number,
          condition: i.condition,
          weightKg: i.weight_kg,
          note: i.note,
          landedCostVnd: BigInt(i.landed),
          hasEstimate: i.has_estimate,
          locked: i.locked,
        })),
    })),
  };
}

/** Cấu hình đang dùng (kèm mã trên hộp) — cho ô "Cấu hình" của lưới nhập máy. */
export async function variantRefs(db: Db, includeIds: readonly string[] = []): Promise<VariantRef[]> {
  const rows = await db<
    {
      id: string;
      model: string;
      sku: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      weight: string | null;
      codes: string[] | null;
    }[]
  >`
    SELECT v.id::text, m.name AS model, v.sku, v.storage, v.color, v.chip, v.memory, v.connectivity, v.default_weight_kg::text AS weight,
           (SELECT array_agg(c.code ORDER BY c.code) FROM variant_codes c WHERE c.variant_id = v.id) AS codes
      FROM product_variants v JOIN product_models m ON m.id = v.model_id
     WHERE v.is_active OR v.id = ANY(${[...includeIds]}::uuid[])
     ORDER BY m.category, m.name, v.sku`;
  return rows.map((r) => ({ id: r.id, label: variantLabel(r.model, r), sku: r.sku, codes: r.codes ?? [], defaultWeightKg: r.weight }));
}

export async function suggestBatchCode(db: Db, now = new Date()): Promise<string> {
  const year = Number(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric" }));
  const rows = await db<{ code: string }[]>`SELECT code FROM batches WHERE code LIKE ${`CH-${year}-%`}`;
  return nextBatchCode(
    year,
    rows.map((r) => r.code),
  );
}

// ---- Chuyến ---------------------------------------------------------------------------------------------

export async function createBatch(db: Db, input: BatchInput): Promise<{ id: string; code: string }> {
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7340012)`; // cấp mã chuyến tuần tự
    const code = input.code ?? (await suggestBatchCode(tx));
    const [dup] = await tx`SELECT 1 FROM batches WHERE code = ${code}`;
    if (dup) throw new PurchasingError("DUPLICATE", `Mã chuyến ${code} đã có`, "code");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO batches (code, name, status, planned_fx_rate, note) VALUES (${code}, ${input.name}, 'DRAFT', ${input.plannedFxRate}, ${input.note})
      RETURNING id::text`;
    await audit(tx, "CREATE", "batch", row.id, null, { ...input, code });
    return { id: row.id, code };
  });
}

export async function updateBatch(db: Db, id: string, input: BatchInput) {
  return db.begin(async (tx) => {
    const [before] = await tx<
      { code: string }[]
    >`SELECT code, name, planned_fx_rate::text, note FROM batches WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!before) throw new PurchasingError("NOT_FOUND", "Không tìm thấy chuyến");
    const code = input.code ?? before.code;
    const [dup] = await tx`SELECT 1 FROM batches WHERE code = ${code} AND id <> ${id}`;
    if (dup) throw new PurchasingError("DUPLICATE", `Mã chuyến ${code} đã có`, "code");
    // tỷ giá dự kiến chỉ để tham khảo — giá vốn luôn tính theo tỷ giá thực tế từng đơn → không cần tính lại
    await tx`UPDATE batches SET code = ${code}, name = ${input.name}, planned_fx_rate = ${input.plannedFxRate}, note = ${input.note}, updated_at = now() WHERE id = ${id}`;
    await audit(tx, "UPDATE", "batch", id, before, { ...input, code });
  });
}

/**
 * Xoá chuyến: còn đơn mua → chặn. Chưa từng có đơn → xoá hẳn. Từng có đơn (đã xoá mềm) → xoá mềm chuyến,
 * giữ lịch sử (không xoá cứng dữ liệu tài chính).
 */
export async function deleteBatch(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [b] = await tx<{ code: string; live: number; ever: number }[]>`
      SELECT code,
             (SELECT COUNT(*)::int FROM purchase_orders WHERE batch_id = b.id AND deleted_at IS NULL) AS live,
             (SELECT COUNT(*)::int FROM purchase_orders WHERE batch_id = b.id) AS ever
        FROM batches b WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!b) throw new PurchasingError("NOT_FOUND", "Không tìm thấy chuyến");
    if (b.live) throw new PurchasingError("IN_USE", `Chuyến ${b.code} còn ${b.live} đơn mua — xoá các đơn trước`);
    const [c] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM costs WHERE batch_id = ${id} AND deleted_at IS NULL`;
    if (c.n) throw new PurchasingError("IN_USE", `Chuyến ${b.code} còn ${c.n} khoản chi phí — xoá chi phí trước`);
    if (b.ever) await tx`UPDATE batches SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
    else await tx`DELETE FROM batches WHERE id = ${id}`;
    await audit(tx, "DELETE", "batch", id, b, null);
  });
}

// ---- Đơn mua --------------------------------------------------------------------------------------------

/** Tạo / sửa đơn mua rồi tính lại giá vốn chuyến (cùng transaction). */
export async function savePurchaseOrder(db: Db, batchId: string, id: string | null, input: PurchaseOrderInput): Promise<{ id: string; recalc: RecalcResult }> {
  return db.begin(async (tx) => {
    const [batch] = await tx`SELECT 1 FROM batches WHERE id = ${batchId} AND deleted_at IS NULL`;
    if (!batch) throw new PurchasingError("NOT_FOUND", "Không tìm thấy chuyến");
    const [supplier] = await tx<{ return_days: number | null }[]>`SELECT return_days FROM suppliers WHERE id = ${input.supplierId}`;
    if (!supplier) throw new PurchasingError("NOT_FOUND", "Không tìm thấy nơi mua", "supplierId");
    if (input.paymentAccountId) {
      const [acc] = await tx`SELECT 1 FROM accounts WHERE id = ${input.paymentAccountId}`;
      if (!acc) throw new PurchasingError("NOT_FOUND", "Không tìm thấy tài khoản thanh toán", "paymentAccountId");
    }
    if (input.currency === "VND" && Number(input.fxRate) !== 1) throw new PurchasingError("INVALID_ROWS", "Đơn trả bằng VND thì tỷ giá phải là 1", "fxRate");
    const deadline = input.returnDeadline ?? returnDeadlineFrom(input.orderedAt, supplier.return_days);
    const values = {
      supplier_id: input.supplierId,
      order_number: input.orderNumber,
      ordered_at: noonVn(input.orderedAt),
      currency: input.currency,
      subtotal: input.subtotal,
      sales_tax: input.salesTax,
      seller_shipping: input.sellerShipping,
      discount: input.discount,
      fx_rate: input.fxRate,
      fx_fee_vnd: input.fxFeeVnd,
      payment_account_id: input.paymentAccountId,
      paid_at: input.paidAt ? noonVn(input.paidAt) : null,
      return_deadline: deadline,
      note: input.note,
    };
    let poId = id;
    if (!poId) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO purchase_orders ${tx({ ...values, batch_id: batchId })} RETURNING id::text`;
      poId = row.id;
      await audit(tx, "CREATE", "purchase_order", poId, null, values);
      await tx`UPDATE batches SET status = 'PURCHASING', updated_at = now() WHERE id = ${batchId} AND status = 'DRAFT'`;
    } else {
      const [before] = await tx`SELECT * FROM purchase_orders WHERE id = ${poId} AND batch_id = ${batchId} AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw new PurchasingError("NOT_FOUND", "Không tìm thấy đơn mua");
      await tx`UPDATE purchase_orders SET ${tx(values)}, updated_at = now() WHERE id = ${poId}`;
      // mốc "Đã đặt" của các máy đi theo ngày đặt của đơn
      await tx`
        UPDATE item_events e SET occurred_at = ${values.ordered_at}
          FROM items i WHERE e.item_id = i.id AND i.purchase_order_id = ${poId} AND e.event_type = 'ORDERED'`;
      await audit(tx, "UPDATE", "purchase_order", poId, before, values);
    }
    const recalc = await recalculateBatch(tx, batchId);
    return { id: poId, recalc };
  });
}

/** Xoá (mềm) đơn mua — chỉ khi đơn không còn máy. */
export async function deletePurchaseOrder(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [po] = await tx<{ batch_id: string; n: number }[]>`
      SELECT batch_id::text, (SELECT COUNT(*)::int FROM items WHERE purchase_order_id = po.id AND deleted_at IS NULL) AS n
        FROM purchase_orders po WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!po) throw new PurchasingError("NOT_FOUND", "Không tìm thấy đơn mua");
    if (po.n) throw new PurchasingError("IN_USE", `Đơn còn ${po.n} máy — xoá các máy trong lưới trước`);
    const [c] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM costs WHERE purchase_order_id = ${id} AND deleted_at IS NULL`;
    if (c.n) throw new PurchasingError("IN_USE", `Đơn có ${c.n} khoản chi phí gắn vào — chuyển hoặc xoá chi phí trước`);
    await tx`UPDATE purchase_orders SET deleted_at = now() WHERE id = ${id}`;
    await audit(tx, "DELETE", "purchase_order", id, { batchId: po.batch_id }, null);
    await recalculateBatch(tx, po.batch_id);
  });
}

// ---- Lưới máy -------------------------------------------------------------------------------------------

export interface SaveItemsResult {
  inserted: number;
  updated: number;
  deleted: number;
  warnings: RowIssue[];
  recalc: RecalcResult;
}

/**
 * Lưu toàn bộ lưới máy của một đơn mua: dòng mới → thêm (kèm mốc "Đã đặt"), dòng có id → sửa nếu đổi,
 * máy không còn trong lưới → xoá mềm (máy đã vào kiện / đã bán thì không xoá được). Kiểm tra trùng
 * Serial/IMEI trên toàn hệ thống trước khi ghi. Cuối cùng tính lại giá vốn chuyến — tất cả trong 1 transaction.
 */
export async function saveItems(db: Db, purchaseOrderId: string, rows: readonly GridRow[]): Promise<SaveItemsResult> {
  return db.begin(async (tx) => {
    const [po] = await tx<{ batch_id: string; ordered_at: string }[]>`
      SELECT batch_id::text, ordered_at::text FROM purchase_orders WHERE id = ${purchaseOrderId} AND deleted_at IS NULL FOR UPDATE`;
    if (!po) throw new PurchasingError("NOT_FOUND", "Không tìm thấy đơn mua");
    const existing = await tx<
      {
        id: string;
        variant_id: string;
        unit_price: string;
        serial_number: string | null;
        imei1: string | null;
        imei2: string | null;
        part_number: string | null;
        model_number: string | null;
        condition: string;
        weight_kg: string | null;
        note: string | null;
        locked: boolean;
      }[]
    >`
      SELECT i.id::text, i.variant_id::text, i.unit_price::text, i.serial_number, i.imei1, i.imei2, i.part_number, i.model_number,
             i.condition::text, i.weight_kg::text, i.note,
             (EXISTS (SELECT 1 FROM shipment_items si WHERE si.item_id = i.id)
               OR EXISTS (SELECT 1 FROM sale_items x WHERE x.item_id = i.id AND x.voided_at IS NULL)) AS locked
        FROM items i WHERE i.purchase_order_id = ${purchaseOrderId} AND i.deleted_at IS NULL FOR UPDATE`;
    const byId = new Map(existing.map((e) => [e.id, e]));

    const variants = await variantRefs(
      tx,
      existing.map((e) => e.variant_id),
    );
    const { items, issues } = validateGrid(rows, variants);
    const errors = issues.filter((i) => i.severity === "error");
    for (const it of items)
      if (it.id && !byId.has(it.id)) errors.push({ row: it.row, field: null, message: "Máy không thuộc đơn này (có thể đã bị xoá)", severity: "error" });

    // trùng với máy khác trong hệ thống (kể cả chuyến khác)
    const keep = new Set(items.filter((i) => i.id).map((i) => i.id!));
    const codes = items.flatMap((i) => [i.serial, i.imei1, i.imei2].filter((x): x is string => !!x));
    if (codes.length) {
      const clash = await tx<{ id: string; code: string; batch: string; field: string }[]>`
        SELECT i.id::text, c.code, b.code AS batch, c.field FROM items i JOIN batches b ON b.id = i.batch_id
        CROSS JOIN LATERAL (VALUES ('serial', i.serial_number), ('imei1', i.imei1), ('imei2', i.imei2)) AS c(field, code)
         WHERE i.deleted_at IS NULL AND c.code = ANY(${codes})`;
      for (const c of clash) {
        if (keep.has(c.id) || byId.has(c.id)) continue; // chính máy đó, hoặc máy cùng đơn đang được sửa
        for (const it of items) {
          const field = it.serial === c.code ? "serial" : it.imei1 === c.code ? "imei1" : it.imei2 === c.code ? "imei2" : null;
          if (field)
            errors.push({
              row: it.row,
              field,
              message: `${c.code} đã có ở một máy khác (chuyến ${c.batch}) — quét lại hay nhầm hàng?`,
              severity: "error",
            });
        }
      }
    }
    const removed = existing.filter((e) => !keep.has(e.id));
    for (const r of removed.filter((e) => e.locked))
      errors.push({
        row: -1,
        field: null,
        message: `Máy ${r.serial_number ?? r.imei1 ?? r.id} đã vào kiện hoặc đã bán — không xoá khỏi đơn được`,
        severity: "error",
      });
    if (errors.length) throw new PurchasingError("INVALID_ROWS", `Có ${errors.length} lỗi trong lưới — sửa các ô tô đỏ rồi lưu lại`, undefined, errors);

    const [{ batch_id: batchId }] = [po];
    let inserted = 0,
      updated = 0;
    for (const it of items) {
      const values = {
        variant_id: it.variantId,
        unit_price: it.unitPrice,
        serial_number: it.serial,
        imei1: it.imei1,
        imei2: it.imei2,
        part_number: it.partNumber,
        model_number: it.modelNumber,
        condition: it.condition,
        weight_kg: it.weightKg,
        note: it.note,
      };
      if (!it.id) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO items ${tx({ ...values, batch_id: batchId, purchase_order_id: purchaseOrderId, status: "ORDERED" })} RETURNING id::text`;
        // giữ đúng thứ tự dòng trong lưới (cùng transaction thì now() trùng nhau)
        await tx`UPDATE items SET created_at = clock_timestamp() WHERE id = ${row.id}`;
        await tx`INSERT INTO item_events (item_id, event_type, occurred_at) VALUES (${row.id}, 'ORDERED', ${po.ordered_at})`;
        await audit(tx, "CREATE", "item", row.id, null, values);
        inserted++;
        continue;
      }
      const before = byId.get(it.id)!;
      if (!changed(before, it)) continue;
      await tx`UPDATE items SET ${tx(values)}, updated_at = now() WHERE id = ${it.id}`;
      await audit(tx, "UPDATE", "item", it.id, before, values);
      updated++;
    }
    for (const r of removed) {
      await tx`UPDATE items SET deleted_at = now() WHERE id = ${r.id}`;
      await audit(tx, "DELETE", "item", r.id, r, null);
    }
    const recalc = await recalculateBatch(tx, batchId);
    return { inserted, updated, deleted: removed.length, warnings: issues.filter((i) => i.severity === "warn"), recalc };
  });
}

function changed(
  b: {
    variant_id: string;
    unit_price: string;
    serial_number: string | null;
    imei1: string | null;
    imei2: string | null;
    part_number: string | null;
    model_number: string | null;
    condition: string;
    weight_kg: string | null;
    note: string | null;
  },
  it: CleanItem,
) {
  const num = (x: string | null) => (x === null ? null : Number(x));
  return (
    b.variant_id !== it.variantId ||
    num(b.unit_price) !== num(it.unitPrice) ||
    b.serial_number !== it.serial ||
    b.imei1 !== it.imei1 ||
    b.imei2 !== it.imei2 ||
    b.part_number !== it.partNumber ||
    b.model_number !== it.modelNumber ||
    b.condition !== it.condition ||
    num(b.weight_kg) !== num(it.weightKg) ||
    b.note !== it.note
  );
}

/** Danh sách chọn cho form đơn mua. */
export async function purchaseOptions(db: Db) {
  const suppliers = await db<{ id: string; name: string; return_days: number | null }[]>`SELECT id::text, name, return_days FROM suppliers ORDER BY name`;
  const accounts = await db<{ id: string; name: string; currency: string }[]>`
    SELECT id::text, name, currency::text FROM accounts WHERE is_active ORDER BY name`;
  return { suppliers, accounts };
}
