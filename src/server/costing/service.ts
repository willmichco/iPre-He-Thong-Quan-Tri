/**
 * Dịch vụ giá vốn — nối bộ máy tính giá vốn (src/domain/costing) với PostgreSQL. Tài liệu 04 mục 3.3 và 5.
 *
 *   recalculateBatches(db, [batchId])  đọc dữ liệu → tính → ghi item_cost_allocations, TRONG CÙNG transaction
 *                                       với thao tác vừa sửa dữ liệu (truyền vào `tx` của thao tác đó).
 *   finalizeBatchCosts(db, batchId)    chốt chi phí: lãi "Tạm tính" → "Chốt", ghi nhật ký kiểm toán.
 *   reopenBatchCosts(db, batchId, lý do) mở lại chuyến đã chốt (bắt buộc lý do, ghi nhật ký).
 *   recalculateSale(db, saleId)        phân bổ giảm giá & chi phí bán hàng của một đơn bán cho từng máy.
 *
 * Kiện gom máy của nhiều chuyến → tự gom thành một "cụm" và tính cùng lúc mọi chuyến liên quan.
 * Chuyến đã chốt (COSTS_FINALIZED/CLOSED): nếu kết quả tính lại làm đổi bất kỳ dòng giá vốn nào của nó →
 * lỗi BATCH_FINALIZED và cả transaction bị huỷ (dữ liệu vừa sửa cũng không được lưu).
 *
 * Không import "server-only" để script dòng lệnh (scripts/costing.ts) dùng chung được; file chỉ nhận kết nối
 * CSDL qua tham số, không đọc bí mật nào.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  computeAllocations,
  computeSaleLines,
  parseScaled,
  type Allocation,
  type AllocationMethod,
  type CostInput,
  type CostKind,
  type CostTarget,
  type CostingWarning,
  type ItemInput,
  type PurchaseOrderInput,
  type ShipmentInput,
} from "@/domain/costing";

type Db = Sql | TransactionSql;

export type CostingServiceErrorCode = "BATCH_NOT_FOUND" | "BATCH_FINALIZED" | "BATCH_NOT_READY" | "REASON_REQUIRED" | "SALE_NOT_FOUND";

export class CostingServiceError extends Error {
  constructor(
    readonly code: CostingServiceErrorCode,
    message: string,
    readonly refs: string[] = [],
  ) {
    super(message);
    this.name = "CostingServiceError";
  }
}

/** Trạng thái chuyến coi như đã chốt giá vốn. */
export const FINALIZED_STATUSES = ["COSTS_FINALIZED", "CLOSED"] as const;
/** Máy còn trên đường (chưa về SG) — chưa được chốt chi phí. */
const IN_TRANSIT_STATUSES = ["ORDERED", "US_IN_TRANSIT", "AT_US_WAREHOUSE", "INTL_IN_TRANSIT", "AT_HN", "DOMESTIC_IN_TRANSIT"];
/** Khoá tư vấn (advisory lock) dùng chung cho mọi lần tính giá vốn — tránh hai lần tính chồng nhau. */
const COSTING_LOCK = 7_340_011;

export type ReturnedItemPolicy = "REALLOCATE" | "WRITE_OFF";

export interface ServiceWarning {
  code: CostingWarning["code"] | "PO_SUBTOTAL_MISMATCH";
  message: string;
  refs: string[];
}

export interface BatchChange {
  batchId: string;
  code: string;
  status: string;
  /** số dòng phân bổ thêm / đổi số tiền hoặc cờ dự toán / bỏ đi */
  inserted: number;
  updated: number;
  deleted: number;
  /** tổng giá vốn chuyến trước và sau khi tính */
  beforeVnd: bigint;
  afterVnd: bigint;
}

export interface RecalcResult {
  /** mọi chuyến đã tính (gồm cả chuyến bị kéo vào do dùng chung kiện / đơn mua) */
  batches: BatchChange[];
  itemCount: number;
  allocationCount: number;
  warnings: ServiceWarning[];
  /** true = chỉ kiểm tra (dryRun), chưa ghi gì */
  dryRun: boolean;
}

export interface RecalcOptions {
  /** chỉ tính và so sánh với dữ liệu đang lưu, không ghi, không chặn chuyến đã chốt */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Tính lại giá vốn cho các chuyến (và mọi chuyến dính chùm qua kiện/đơn mua). Gọi trong transaction của thao
 * tác sửa dữ liệu để "sửa + tính lại" là một khối — lỗi ở đâu thì huỷ cả hai.
 */
export async function recalculateBatches(db: Db, batchIds: readonly string[], opts: RecalcOptions = {}): Promise<RecalcResult> {
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${COSTING_LOCK})`;
    const ids = await connectedBatches(tx, batchIds);
    const batches = await tx<{ id: string; code: string; status: string }[]>`
      SELECT id::text, code, status::text FROM batches WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const missing = batchIds.filter((id) => !batches.some((b) => b.id === id));
    if (missing.length) throw new CostingServiceError("BATCH_NOT_FOUND", `Không tìm thấy chuyến ${missing.join(", ")}`, missing);

    const input = await loadInput(tx, ids);
    const { allocations, warnings } = computeAllocations(input.costing);
    const stored = await loadStored(tx, input.itemIds, input.deletedItemIds);
    const diff = diffAllocations(stored, allocations);

    const batchOf = new Map(input.costing.items.map((i) => [i.id, i.batchId]));
    for (const [itemId, batchId] of input.deletedItemBatch) batchOf.set(itemId, batchId);
    const changes = batches.map<BatchChange>((b) => ({
      batchId: b.id,
      code: b.code,
      status: b.status,
      inserted: 0,
      updated: 0,
      deleted: 0,
      beforeVnd: 0n,
      afterVnd: 0n,
    }));
    const byBatch = new Map(changes.map((c) => [c.batchId, c]));
    for (const s of stored.values()) {
      const c = byBatch.get(batchOf.get(s.itemId)!);
      if (c && !input.deletedItemIds.includes(s.itemId)) c.beforeVnd += s.amountVnd;
    }
    for (const a of allocations) byBatch.get(batchOf.get(a.itemId)!)!.afterVnd += a.amountVnd;
    for (const [kind, rows] of [
      ["inserted", diff.insert],
      ["updated", diff.update],
      ["deleted", diff.remove],
    ] as const)
      for (const r of rows) {
        const c = byBatch.get(batchOf.get(r.itemId)!);
        if (c) c[kind]++;
      }

    const result: RecalcResult = {
      batches: changes,
      itemCount: input.itemIds.length,
      allocationCount: allocations.length,
      warnings: [...warnings, ...input.warnings],
      dryRun: !!opts.dryRun,
    };
    if (opts.dryRun) return result;

    const locked = changes.filter((c) => (FINALIZED_STATUSES as readonly string[]).includes(c.status) && c.inserted + c.updated + c.deleted > 0);
    if (locked.length)
      throw new CostingServiceError(
        "BATCH_FINALIZED",
        `Chuyến ${locked.map((c) => c.code).join(", ")} đã chốt chi phí — thao tác này làm đổi giá vốn nên bị chặn. ` +
          `Muốn sửa phải "Mở lại chuyến" (kèm lý do).`,
        locked.map((c) => c.batchId),
      );

    await writeDiff(tx, diff);
    return result;
  });
}

/** Một chuyến — cách gọi quen thuộc ở tài liệu 04. */
export function recalculateBatch(db: Db, batchId: string, opts?: RecalcOptions) {
  return recalculateBatches(db, [batchId], opts);
}

/** Kiểm tra mọi chuyến: giá vốn đang lưu có khớp với bộ máy không (dùng cho CI và nút "Kiểm tra"). */
export async function checkAllBatches(db: Db): Promise<RecalcResult[]> {
  const rows = await db<{ id: string }[]>`SELECT id::text FROM batches ORDER BY created_at, id`;
  const seen = new Set<string>();
  const out: RecalcResult[] = [];
  for (const { id } of rows) {
    if (seen.has(id)) continue;
    const r = await recalculateBatches(db, [id], { dryRun: true });
    r.batches.forEach((b) => seen.add(b.batchId));
    out.push(r);
  }
  return out;
}

// ---- Chốt / mở lại chuyến -------------------------------------------------------------------------------

export interface AuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Chốt chi phí chuyến: mọi máy đã về SG (hoặc đã xử lý mất/trả), không còn chi phí dự toán. */
export async function finalizeBatchCosts(db: Db, batchId: string, meta: AuditMeta = {}) {
  return db.begin(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if ((FINALIZED_STATUSES as readonly string[]).includes(batch.status))
      throw new CostingServiceError("BATCH_FINALIZED", `Chuyến ${batch.code} đã chốt chi phí rồi`, [batchId]);

    const recalc = await recalculateBatches(tx, [batchId]);
    const notArrived = await tx<{ id: string }[]>`
      SELECT i.id::text FROM items i
      LEFT JOIN v_item_milestones m ON m.item_id = i.id
      WHERE i.batch_id = ${batchId} AND i.deleted_at IS NULL
        AND (i.status::text = ANY(${IN_TRANSIT_STATUSES}) OR (i.status = 'RESERVED' AND m.sg_received_at IS NULL))`;
    const estimates = await tx<{ id: string }[]>`
      SELECT DISTINCT a.cost_id::text AS id FROM item_cost_allocations a
      JOIN items i ON i.id = a.item_id
      WHERE i.batch_id = ${batchId} AND i.deleted_at IS NULL AND a.is_estimate`;
    const problems: string[] = [];
    if (notArrived.length) problems.push(`${notArrived.length} máy chưa về SG (hoặc chưa xử lý mất/trả)`);
    if (estimates.length) problems.push(`${estimates.length} khoản chi phí còn là dự toán`);
    if (problems.length)
      throw new CostingServiceError("BATCH_NOT_READY", `Chưa chốt được chuyến ${batch.code}: ${problems.join("; ")}`, [
        ...notArrived.map((r) => r.id),
        ...estimates.map((r) => r.id),
      ]);

    const summary = await batchSummaryRow(tx, batchId);
    await tx`UPDATE batches SET status = 'COSTS_FINALIZED', costs_finalized_at = now(), updated_at = now() WHERE id = ${batchId}`;
    await audit(tx, "FINALIZE", batchId, { status: batch.status }, { status: "COSTS_FINALIZED", ...summary }, meta);
    return { batchId, code: batch.code, summary, recalc };
  });
}

/** Mở lại chuyến đã chốt — bắt buộc lý do; trạng thái về ARRIVED, lãi trở lại "Tạm tính". */
export async function reopenBatchCosts(db: Db, batchId: string, reason: string, meta: AuditMeta = {}) {
  const why = reason.trim();
  if (why.length < 5) throw new CostingServiceError("REASON_REQUIRED", "Mở lại chuyến phải ghi lý do (ít nhất 5 ký tự)", [batchId]);
  return db.begin(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!(FINALIZED_STATUSES as readonly string[]).includes(batch.status))
      throw new CostingServiceError("BATCH_NOT_READY", `Chuyến ${batch.code} chưa chốt chi phí — không cần mở lại`, [batchId]);
    const summary = await batchSummaryRow(tx, batchId);
    await tx`
      UPDATE batches SET status = 'ARRIVED', costs_finalized_at = NULL, closed_at = NULL, updated_at = now() WHERE id = ${batchId}`;
    await audit(tx, "REOPEN", batchId, { status: batch.status, ...summary }, { status: "ARRIVED", reason: why }, meta);
    return { batchId, code: batch.code };
  });
}

// ---- Đơn bán ------------------------------------------------------------------------------------------

/** Phân bổ giảm giá & chi phí bán hàng của đơn bán cho các dòng còn hiệu lực (sale_items). */
export async function recalculateSale(db: Db, saleId: string) {
  return db.begin(async (tx) => {
    const [sale] = await tx<{ discount: string }[]>`SELECT discount_vnd::text AS discount FROM sales WHERE id = ${saleId} FOR UPDATE`;
    if (!sale) throw new CostingServiceError("SALE_NOT_FOUND", `Không tìm thấy đơn bán ${saleId}`, [saleId]);
    const lines = await tx<{ id: string; price: string }[]>`
      SELECT id::text, price_vnd::text AS price FROM sale_items WHERE sale_id = ${saleId} AND voided_at IS NULL ORDER BY id`;
    const expenses = await tx<{ amount: string }[]>`SELECT amount_vnd::text AS amount FROM sale_expenses WHERE sale_id = ${saleId}`;
    const computed = computeSaleLines({
      discountVnd: BigInt(sale.discount),
      expensesVnd: expenses.map((e) => BigInt(e.amount)),
      lines: lines.map((l) => ({ itemId: l.id, priceVnd: BigInt(l.price) })),
    });
    for (const c of computed)
      await tx`
        UPDATE sale_items SET discount_alloc_vnd = ${c.discountAllocVnd.toString()}::bigint,
                              expense_alloc_vnd  = ${c.expenseAllocVnd.toString()}::bigint
        WHERE id = ${c.itemId}`;
    // dòng đã huỷ không gánh giảm giá / chi phí của đơn nữa
    await tx`UPDATE sale_items SET discount_alloc_vnd = 0, expense_alloc_vnd = 0 WHERE sale_id = ${saleId} AND voided_at IS NOT NULL`;
    return computed;
  });
}

// ---- Nội bộ ---------------------------------------------------------------------------------------------

/**
 * Gom "cụm" chuyến phải tính cùng nhau: chuyến ban đầu + chuyến của mọi máy nằm chung kiện (kể cả kiện gắn
 * chuyến) + chuyến của đơn mua mà máy thuộc về (và ngược lại). Lặp tới khi không thêm được chuyến nào.
 */
async function connectedBatches(tx: TransactionSql, start: readonly string[]): Promise<string[]> {
  const seen = new Set(start);
  let frontier = [...start];
  while (frontier.length) {
    const rows = await tx<{ id: string }[]>`
      SELECT DISTINCT b::text AS id FROM (
        SELECT i2.batch_id AS b
          FROM items i
          JOIN shipment_items si  ON si.item_id = i.id
          JOIN shipment_items si2 ON si2.shipment_id = si.shipment_id
          JOIN items i2           ON i2.id = si2.item_id AND i2.deleted_at IS NULL
         WHERE i.batch_id = ANY(${frontier}::uuid[]) AND i.deleted_at IS NULL
        UNION
        SELECT po.batch_id FROM items i JOIN purchase_orders po ON po.id = i.purchase_order_id
         WHERE i.batch_id = ANY(${frontier}::uuid[]) AND i.deleted_at IS NULL
        UNION
        SELECT i.batch_id FROM purchase_orders po JOIN items i ON i.purchase_order_id = po.id AND i.deleted_at IS NULL
         WHERE po.batch_id = ANY(${frontier}::uuid[]) AND po.deleted_at IS NULL
        UNION
        SELECT i.batch_id FROM shipments s
          JOIN shipment_items si ON si.shipment_id = s.id
          JOIN items i           ON i.id = si.item_id AND i.deleted_at IS NULL
         WHERE s.batch_id = ANY(${frontier}::uuid[])
      ) x`;
    frontier = rows.map((r) => r.id).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return [...seen].sort();
}

interface LoadedInput {
  costing: { purchaseOrders: PurchaseOrderInput[]; items: ItemInput[]; shipments: ShipmentInput[]; costs: CostInput[] };
  itemIds: string[];
  /** máy đã xoá mềm của các chuyến — dọn dòng phân bổ cũ */
  deletedItemIds: string[];
  deletedItemBatch: Map<string, string>;
  warnings: ServiceWarning[];
}

async function loadInput(tx: TransactionSql, batchIds: string[]): Promise<LoadedInput> {
  const policy = await returnedItemPolicy(tx);
  const items = await tx<{ id: string; batch_id: string; po_id: string; unit_price: string; weight: string | null; status: string }[]>`
    SELECT i.id::text, i.batch_id::text, i.purchase_order_id::text AS po_id, i.unit_price::text,
           COALESCE(i.weight_kg, pv.default_weight_kg)::text AS weight, i.status::text
      FROM items i JOIN product_variants pv ON pv.id = i.variant_id
     WHERE i.batch_id = ANY(${batchIds}::uuid[]) AND i.deleted_at IS NULL
     ORDER BY i.created_at, i.id`;
  const deleted = await tx<{ id: string; batch_id: string }[]>`
    SELECT id::text, batch_id::text FROM items WHERE batch_id = ANY(${batchIds}::uuid[]) AND deleted_at IS NOT NULL`;
  const itemIds = items.map((i) => i.id);

  const pos = await tx<
    { id: string; batch_id: string; fx: string; subtotal: string; tax: string; ship: string; disc: string; fee: string; goods: string | null; n: number }[]
  >`
    SELECT po.id::text, po.batch_id::text, po.fx_rate::text AS fx, po.subtotal::text, po.sales_tax::text AS tax,
           po.seller_shipping::text AS ship, po.discount::text AS disc, po.fx_fee_vnd::text AS fee,
           (SELECT SUM(unit_price)::text FROM items WHERE purchase_order_id = po.id AND deleted_at IS NULL) AS goods,
           (SELECT COUNT(*)::int FROM items WHERE purchase_order_id = po.id AND deleted_at IS NULL) AS n
      FROM purchase_orders po
     WHERE po.deleted_at IS NULL
       AND (po.batch_id = ANY(${batchIds}::uuid[]) OR po.id IN (SELECT purchase_order_id FROM items WHERE id = ANY(${itemIds}::uuid[])))
     ORDER BY po.ordered_at, po.id`;

  const shipmentRows = await tx<{ shipment_id: string; item_id: string }[]>`
    SELECT si.shipment_id::text, si.item_id::text
      FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL
     WHERE si.shipment_id IN (SELECT shipment_id FROM shipment_items WHERE item_id = ANY(${itemIds}::uuid[]))
        OR si.shipment_id IN (SELECT id FROM shipments WHERE batch_id = ANY(${batchIds}::uuid[]))
     ORDER BY si.shipment_id, i.created_at, i.id`;
  const emptyShipments = await tx<{ id: string }[]>`SELECT id::text FROM shipments WHERE batch_id = ANY(${batchIds}::uuid[])`;
  const shipments = new Map<string, string[]>(emptyShipments.map((s) => [s.id, []]));
  for (const r of shipmentRows) shipments.set(r.shipment_id, [...(shipments.get(r.shipment_id) ?? []), r.item_id]);

  const poIds = pos.map((p) => p.id);
  const shipmentIds = [...shipments.keys()];
  const costs = await tx<
    {
      id: string;
      kind: CostKind;
      batch_id: string | null;
      po_id: string | null;
      shipment_id: string | null;
      item_id: string | null;
      amount_vnd: string;
      method: AllocationMethod;
      is_estimate: boolean;
    }[]
  >`
    SELECT id::text, kind::text AS kind, batch_id::text, purchase_order_id::text AS po_id, shipment_id::text, item_id::text,
           amount_vnd::text, allocation_method::text AS method, is_estimate
      FROM costs
     WHERE deleted_at IS NULL
       AND (batch_id = ANY(${batchIds}::uuid[]) OR purchase_order_id = ANY(${poIds}::uuid[])
            OR shipment_id = ANY(${shipmentIds}::uuid[]) OR item_id = ANY(${itemIds}::uuid[]))
     ORDER BY incurred_at, created_at, id`;
  const shares = await tx<{ cost_id: string; item_id: string; amount_vnd: string }[]>`
    SELECT cost_id::text, item_id::text, amount_vnd::text FROM cost_manual_shares
     WHERE cost_id = ANY(${costs.filter((c) => c.method === "MANUAL").map((c) => c.id)}::uuid[])`;

  const warnings: ServiceWarning[] = [];
  for (const p of pos) {
    if (p.n > 0 && p.goods !== null && parseScaled(p.goods, 2) !== parseScaled(p.subtotal, 2))
      warnings.push({
        code: "PO_SUBTOTAL_MISMATCH",
        message: `Đơn mua ${p.id}: tổng đơn giá các máy (${p.goods}) khác subtotal của đơn (${p.subtotal}) — có thể còn máy chưa nhập`,
        refs: [p.id],
      });
  }

  return {
    costing: {
      purchaseOrders: pos.map((p) => ({
        id: p.id,
        fxRate: p.fx,
        salesTax: p.tax,
        sellerShipping: p.ship,
        discount: p.disc,
        fxFeeVnd: BigInt(p.fee),
      })),
      items: items.map((i) => ({
        id: i.id,
        batchId: i.batch_id,
        purchaseOrderId: i.po_id,
        unitPrice: i.unit_price,
        weightKg: i.weight,
        excludedFromCosts: policy === "REALLOCATE" && i.status === "RETURNED_TO_SELLER",
      })),
      shipments: [...shipments].map(([id, ids]) => ({ id, itemIds: ids })),
      costs: costs.map((c) => ({
        id: c.id,
        kind: c.kind,
        target: targetOf(c),
        amountVnd: BigInt(c.amount_vnd),
        method: c.method,
        isEstimate: c.is_estimate,
        manualShares: shares.filter((s) => s.cost_id === c.id).map((s) => ({ itemId: s.item_id, amountVnd: BigInt(s.amount_vnd) })),
      })),
    },
    itemIds,
    deletedItemIds: deleted.map((d) => d.id),
    deletedItemBatch: new Map(deleted.map((d) => [d.id, d.batch_id])),
    warnings,
  };
}

function targetOf(c: { batch_id: string | null; po_id: string | null; shipment_id: string | null; item_id: string | null }): CostTarget {
  if (c.batch_id) return { type: "BATCH", id: c.batch_id };
  if (c.po_id) return { type: "PURCHASE_ORDER", id: c.po_id };
  if (c.shipment_id) return { type: "SHIPMENT", id: c.shipment_id };
  return { type: "ITEM", id: c.item_id! };
}

/** Cài đặt costing.returned_item_policy: "REALLOCATE" (mặc định — chi phí chung dồn cho máy còn lại) | "WRITE_OFF" (máy trả vẫn gánh, ghi lỗ). */
async function returnedItemPolicy(tx: TransactionSql): Promise<ReturnedItemPolicy> {
  const [row] = await tx<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'costing.returned_item_policy'`;
  return row?.value === "WRITE_OFF" ? "WRITE_OFF" : "REALLOCATE";
}

interface StoredRow {
  id: string;
  itemId: string;
  component: string;
  costId: string | null;
  amountVnd: bigint;
  isEstimate: boolean;
}

const keyOf = (a: { itemId: string; component: string; costId: string | null }) => `${a.itemId}|${a.component}|${a.costId ?? ""}`;

async function loadStored(tx: TransactionSql, itemIds: string[], deletedItemIds: string[]): Promise<Map<string, StoredRow>> {
  const rows = await tx<{ id: string; item_id: string; component: string; cost_id: string | null; amount_vnd: string; is_estimate: boolean }[]>`
    SELECT id::text, item_id::text, component, cost_id::text, amount_vnd::text, is_estimate
      FROM item_cost_allocations WHERE item_id = ANY(${[...itemIds, ...deletedItemIds]}::uuid[])`;
  return new Map(
    rows.map((r) => {
      const s: StoredRow = {
        id: r.id,
        itemId: r.item_id,
        component: r.component,
        costId: r.cost_id,
        amountVnd: BigInt(r.amount_vnd),
        isEstimate: r.is_estimate,
      };
      return [keyOf(s), s];
    }),
  );
}

interface Diff {
  insert: Allocation[];
  update: (Allocation & { id: string })[];
  remove: StoredRow[];
}

function diffAllocations(stored: Map<string, StoredRow>, next: Allocation[]): Diff {
  const diff: Diff = { insert: [], update: [], remove: [] };
  const keep = new Set<string>();
  for (const a of next) {
    const k = keyOf(a);
    keep.add(k);
    const s = stored.get(k);
    if (!s) diff.insert.push(a);
    else if (s.amountVnd !== a.amountVnd || s.isEstimate !== a.isEstimate) diff.update.push({ ...a, id: s.id });
  }
  for (const [k, s] of stored) if (!keep.has(k)) diff.remove.push(s);
  return diff;
}

async function writeDiff(tx: TransactionSql, diff: Diff) {
  if (diff.remove.length) await tx`DELETE FROM item_cost_allocations WHERE id = ANY(${diff.remove.map((r) => r.id)}::uuid[])`;
  for (const u of diff.update)
    await tx`
      UPDATE item_cost_allocations SET amount_vnd = ${u.amountVnd.toString()}::bigint, is_estimate = ${u.isEstimate}, computed_at = now()
       WHERE id = ${u.id}`;
  if (diff.insert.length) {
    const rows = diff.insert.map((a) => ({
      item_id: a.itemId,
      component: a.component,
      cost_id: a.costId,
      amount_vnd: a.amountVnd.toString(),
      is_estimate: a.isEstimate,
    }));
    await tx`INSERT INTO item_cost_allocations ${tx(rows, "item_id", "component", "cost_id", "amount_vnd", "is_estimate")}`;
  }
}

async function lockBatch(tx: TransactionSql, batchId: string) {
  const [b] = await tx<{ code: string; status: string }[]>`SELECT code, status::text FROM batches WHERE id = ${batchId} FOR UPDATE`;
  if (!b) throw new CostingServiceError("BATCH_NOT_FOUND", `Không tìm thấy chuyến ${batchId}`, [batchId]);
  return b;
}

async function batchSummaryRow(tx: TransactionSql, batchId: string) {
  const [s] = await tx<{ total: string; revenue: string; profit: string; unsold: string; roi: string | null }[]>`
    SELECT total_landed_cost_vnd::text AS total, revenue_vnd::text AS revenue, realized_profit_vnd::text AS profit,
           unsold_cost_vnd::text AS unsold, roi_on_sold_pct::text AS roi
      FROM v_batch_summary WHERE batch_id = ${batchId}`;
  return { totalLandedCostVnd: s.total, revenueVnd: s.revenue, realizedProfitVnd: s.profit, unsoldCostVnd: s.unsold, roiOnSoldPct: s.roi };
}

async function audit(tx: TransactionSql, action: "FINALIZE" | "REOPEN", batchId: string, before: object, after: object, meta: AuditMeta) {
  await tx`
    INSERT INTO audit_logs (action, entity_type, entity_id, before, after, ip, user_agent)
    VALUES (${action}, 'batch', ${batchId}, ${tx.json(before as never)}, ${tx.json(after as never)}, ${meta.ip ?? null}::inet, ${meta.userAgent ?? null})`;
}
