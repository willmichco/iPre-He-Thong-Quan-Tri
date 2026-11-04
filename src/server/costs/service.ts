/**
 * Dịch vụ chi phí cấu thành giá vốn (bảng `costs`, nhóm B–E). Thêm / sửa / xoá chi phí → tính lại giá vốn các
 * chuyến liên quan TRONG CÙNG transaction (chuyến đã chốt → BATCH_FINALIZED, huỷ cả khối). Xoá là xoá mềm.
 */
import type { Sql, TransactionSql } from "postgres";
import type { AllocationMethod, CostKind } from "@/domain/costing";
import { parseManualShares, type CostFormInput, type TargetType } from "@/domain/costs";
import { recalculateBatches, type RecalcResult } from "@/server/costing/service";

type Db = Sql | TransactionSql;

export type CostErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "NO_ITEMS";

export class CostError extends Error {
  constructor(
    readonly code: CostErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CostError";
  }
}

async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", id: string, before: unknown, after: unknown) {
  const json = (v: unknown) => (v == null ? null : tx.json(JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as never));
  await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after) VALUES (${action}, 'cost', ${id}, ${json(before)}, ${json(after)})`;
}

const COLUMN: Record<TargetType, "batch_id" | "purchase_order_id" | "shipment_id" | "item_id"> = {
  BATCH: "batch_id",
  PURCHASE_ORDER: "purchase_order_id",
  SHIPMENT: "shipment_id",
  ITEM: "item_id",
};

/** Các máy (còn hiệu lực) thuộc đối tượng chi phí gắn vào. */
async function targetItems(tx: TransactionSql, type: TargetType, id: string) {
  const rows =
    type === "BATCH"
      ? await tx<{ id: string; batch_id: string }[]>`SELECT id::text, batch_id::text FROM items WHERE batch_id = ${id} AND deleted_at IS NULL`
      : type === "PURCHASE_ORDER"
        ? await tx<{ id: string; batch_id: string }[]>`SELECT id::text, batch_id::text FROM items WHERE purchase_order_id = ${id} AND deleted_at IS NULL`
        : type === "SHIPMENT"
          ? await tx<{ id: string; batch_id: string }[]>`
              SELECT i.id::text, i.batch_id::text FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL WHERE si.shipment_id = ${id}`
          : await tx<{ id: string; batch_id: string }[]>`SELECT id::text, batch_id::text FROM items WHERE id = ${id} AND deleted_at IS NULL`;
  return rows;
}

async function targetExists(tx: TransactionSql, type: TargetType, id: string) {
  const [r] =
    type === "BATCH"
      ? await tx`SELECT 1 FROM batches WHERE id = ${id} AND deleted_at IS NULL`
      : type === "PURCHASE_ORDER"
        ? await tx`SELECT 1 FROM purchase_orders WHERE id = ${id} AND deleted_at IS NULL`
        : type === "SHIPMENT"
          ? await tx`SELECT 1 FROM shipments WHERE id = ${id}`
          : await tx`SELECT 1 FROM items WHERE id = ${id} AND deleted_at IS NULL`;
  return !!r;
}

/**
 * Thêm (id = null) hoặc sửa chi phí, kèm danh sách chia tay khi cách chia là "Nhập tay từng máy".
 * Đối tượng chưa có máy nào → lỗi rõ ràng (không để chi phí "treo" không phân bổ được).
 */
export async function saveCost(db: Db, id: string | null, input: CostFormInput): Promise<{ id: string; recalc: RecalcResult }> {
  return db.begin(async (tx) => {
    const { type, id: targetId } = input.target;
    if (!(await targetExists(tx, type, targetId))) throw new CostError("NOT_FOUND", "Không tìm thấy đối tượng gắn chi phí", "target");
    const items = await targetItems(tx, type, targetId);
    if (!items.length)
      throw new CostError(
        "NO_ITEMS",
        type === "SHIPMENT" ? "Kiện chưa có máy — quét máy vào kiện trước rồi nhập chi phí" : "Đối tượng này chưa có máy nào",
        "target",
      );
    if (input.accountId) {
      const [a] = await tx`SELECT 1 FROM accounts WHERE id = ${input.accountId}`;
      if (!a) throw new CostError("NOT_FOUND", "Không tìm thấy tài khoản", "accountId");
    }

    // chia tay: mã máy → id máy (phải thuộc đối tượng), tổng phải bằng số tiền VND
    let shares: { itemId: string; amountVnd: bigint }[] = [];
    if (input.method === "MANUAL") {
      const parsed = parseManualShares(input.manualShares);
      if (parsed.errors.length) throw new CostError("INVALID_INPUT", parsed.errors.join("; "), "manualShares");
      if (!parsed.shares.length) throw new CostError("INVALID_INPUT", 'Nhập số tiền từng máy, mỗi dòng "Serial hoặc IMEI: số tiền"', "manualShares");
      const codes = parsed.shares.map((s) => s.code);
      const found = await tx<{ id: string; serial_number: string | null; imei1: string | null; imei2: string | null }[]>`
        SELECT id::text, serial_number, imei1, imei2 FROM items
         WHERE deleted_at IS NULL AND id = ANY(${items.map((i) => i.id)}::uuid[])
           AND (serial_number = ANY(${codes}) OR imei1 = ANY(${codes}) OR imei2 = ANY(${codes}))`;
      const missing: string[] = [];
      shares = parsed.shares.flatMap((s) => {
        const it = found.find((f) => f.serial_number === s.code || f.imei1 === s.code || f.imei2 === s.code);
        if (!it) missing.push(s.code);
        return it ? [{ itemId: it.id, amountVnd: s.amountVnd }] : [];
      });
      if (missing.length) throw new CostError("INVALID_INPUT", `Không thuộc đối tượng đã chọn: ${missing.join(", ")}`, "manualShares");
      const total = shares.reduce((a, s) => a + s.amountVnd, 0n);
      if (total !== input.amountVnd)
        throw new CostError(
          "INVALID_INPUT",
          `Tổng chia tay ${total.toLocaleString("vi-VN")} đ khác số tiền chi phí ${input.amountVnd.toLocaleString("vi-VN")} đ (lệch ${(input.amountVnd - total).toLocaleString("vi-VN")} đ)`,
          "manualShares",
        );
    }

    const values = {
      kind: input.kind,
      batch_id: null as string | null,
      purchase_order_id: null as string | null,
      shipment_id: null as string | null,
      item_id: null as string | null,
      description: input.description,
      currency: input.currency,
      amount: input.amount,
      fx_rate: input.fxRate,
      allocation_method: input.method,
      is_estimate: input.isEstimate,
      has_valid_invoice: input.hasValidInvoice,
      incurred_at: input.incurredAt,
      account_id: input.accountId,
      paid_at: input.paidAt ? `${input.paidAt}T12:00:00+07:00` : null,
      note: input.note,
    };
    values[COLUMN[type]] = targetId;

    let costId = id;
    const affected = new Set(items.map((i) => i.batch_id));
    if (!costId) {
      const [row] = await tx<{ id: string }[]>`INSERT INTO costs ${tx(values)} RETURNING id::text`;
      costId = row.id;
      await audit(tx, "CREATE", costId, null, { ...values, manualShares: shares });
    } else {
      const [before] = await tx<{ batch_id: string | null; purchase_order_id: string | null; shipment_id: string | null; item_id: string | null }[]>`
        SELECT batch_id::text, purchase_order_id::text, shipment_id::text, item_id::text, kind::text, amount::text, fx_rate::text,
               allocation_method::text, is_estimate, currency::text
          FROM costs WHERE id = ${costId} AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw new CostError("NOT_FOUND", "Không tìm thấy chi phí");
      // đổi đối tượng → chuyến cũ cũng phải tính lại (bỏ phần phân bổ cũ)
      const oldType = (Object.keys(COLUMN) as TargetType[]).find((t) => before[COLUMN[t]])!;
      for (const it of await targetItems(tx, oldType, before[COLUMN[oldType]]!)) affected.add(it.batch_id);
      await tx`UPDATE costs SET ${tx(values)}, updated_at = now() WHERE id = ${costId}`;
      await audit(tx, "UPDATE", costId, before, { ...values, manualShares: shares });
    }
    await tx`DELETE FROM cost_manual_shares WHERE cost_id = ${costId}`;
    if (shares.length)
      await tx`INSERT INTO cost_manual_shares ${tx(shares.map((s) => ({ cost_id: costId, item_id: s.itemId, amount_vnd: s.amountVnd.toString() })))}`;
    const recalc = await recalculateBatches(tx, [...affected]);
    return { id: costId, recalc };
  });
}

/** Xoá mềm chi phí + tính lại giá vốn (chuyến đã chốt → chặn). */
export async function deleteCost(db: Db, id: string): Promise<RecalcResult> {
  return db.begin(async (tx) => {
    const [c] = await tx<{ kind: string; amount: string }[]>`SELECT kind::text, amount::text FROM costs WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!c) throw new CostError("NOT_FOUND", "Không tìm thấy chi phí");
    const batches = await tx<{ id: string }[]>`
      SELECT DISTINCT i.batch_id::text AS id FROM item_cost_allocations a JOIN items i ON i.id = a.item_id WHERE a.cost_id = ${id}`;
    await tx`UPDATE costs SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
    await audit(tx, "DELETE", id, c, null);
    return recalculateBatches(
      tx,
      batches.map((b) => b.id),
    );
  });
}

// ---- Đọc ------------------------------------------------------------------------------------------------

export interface CostRow {
  id: string;
  kind: CostKind;
  targetType: TargetType;
  targetId: string;
  targetLabel: string;
  description: string | null;
  currency: "VND" | "USD";
  amount: string;
  fxRate: string;
  amountVnd: bigint;
  method: AllocationMethod;
  isEstimate: boolean;
  hasValidInvoice: boolean;
  incurredAt: string;
  accountId: string | null;
  paidAt: string | null;
  note: string | null;
  /** đã phân bổ (tổng các dòng giá vốn của khoản này) — phải bằng amountVnd */
  allocatedVnd: bigint;
  allocatedItems: number;
  manualShares: string;
}

/** Chi phí liên quan đến một chuyến (gắn chuyến / đơn / kiện / máy của chuyến) hoặc một kiện. */
export async function listCosts(db: Db, scope: { batchId?: string; shipmentId?: string }): Promise<CostRow[]> {
  const rows = await db<
    {
      id: string;
      kind: CostKind;
      batch_id: string | null;
      purchase_order_id: string | null;
      shipment_id: string | null;
      item_id: string | null;
      label: string;
      description: string | null;
      currency: "VND" | "USD";
      amount: string;
      fx_rate: string;
      amount_vnd: string;
      method: AllocationMethod;
      is_estimate: boolean;
      has_valid_invoice: boolean;
      incurred_at: string;
      account_id: string | null;
      paid_at: string | null;
      note: string | null;
      allocated: string;
      n: number;
      shares: string | null;
    }[]
  >`
    SELECT c.id::text, c.kind::text AS kind, c.batch_id::text, c.purchase_order_id::text, c.shipment_id::text, c.item_id::text,
           CASE WHEN c.batch_id IS NOT NULL THEN 'Chuyến ' || b.code
                WHEN c.purchase_order_id IS NOT NULL THEN 'Đơn ' || COALESCE(po.order_number, s.name)
                WHEN c.shipment_id IS NOT NULL THEN 'Kiện ' || COALESCE(sh.tracking_number, sh.reference_code, '(chưa có mã)')
                ELSE 'Máy ' || COALESCE(it.serial_number, it.imei1, '?') END AS label,
           c.description, c.currency::text AS currency, c.amount::text, c.fx_rate::text, c.amount_vnd::text,
           c.allocation_method::text AS method, c.is_estimate, c.has_valid_invoice, c.incurred_at::text,
           c.account_id::text, to_char(c.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS paid_at, c.note,
           COALESCE((SELECT SUM(a.amount_vnd) FROM item_cost_allocations a WHERE a.cost_id = c.id), 0)::text AS allocated,
           (SELECT COUNT(*)::int FROM item_cost_allocations a WHERE a.cost_id = c.id) AS n,
           (SELECT string_agg(COALESCE(i2.serial_number, i2.imei1) || ': ' || m.amount_vnd, E'\n' ORDER BY i2.created_at)
              FROM cost_manual_shares m JOIN items i2 ON i2.id = m.item_id WHERE m.cost_id = c.id) AS shares
      FROM costs c
      LEFT JOIN batches b ON b.id = c.batch_id
      LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id LEFT JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN shipments sh ON sh.id = c.shipment_id
      LEFT JOIN items it ON it.id = c.item_id
     WHERE c.deleted_at IS NULL
       AND (${scope.shipmentId ?? null}::uuid IS NULL OR c.shipment_id = ${scope.shipmentId ?? null}::uuid)
       AND (${scope.batchId ?? null}::uuid IS NULL
            OR c.batch_id = ${scope.batchId ?? null}::uuid
            OR EXISTS (SELECT 1 FROM item_cost_allocations a JOIN items i ON i.id = a.item_id
                        WHERE a.cost_id = c.id AND i.batch_id = ${scope.batchId ?? null}::uuid))
     ORDER BY c.incurred_at, c.created_at, c.id`;
  return rows.map((r) => {
    const targetType: TargetType = r.batch_id ? "BATCH" : r.purchase_order_id ? "PURCHASE_ORDER" : r.shipment_id ? "SHIPMENT" : "ITEM";
    return {
      id: r.id,
      kind: r.kind,
      targetType,
      targetId: (r.batch_id ?? r.purchase_order_id ?? r.shipment_id ?? r.item_id)!,
      targetLabel: r.label,
      description: r.description,
      currency: r.currency,
      amount: r.amount,
      fxRate: r.fx_rate,
      amountVnd: BigInt(r.amount_vnd),
      method: r.method,
      isEstimate: r.is_estimate,
      hasValidInvoice: r.has_valid_invoice,
      incurredAt: r.incurred_at,
      accountId: r.account_id,
      paidAt: r.paid_at,
      note: r.note,
      allocatedVnd: BigInt(r.allocated),
      allocatedItems: r.n,
      manualShares: r.shares ?? "",
    };
  });
}

/** Cấu trúc giá vốn của chuyến theo nhóm (A giá mua · B nội địa Mỹ · C Mỹ→VN · D HN→SG · E khác) + đối soát. */
export async function costBreakdown(db: Db, batchId: string) {
  const [r] = await db<{ purchase: string; us: string; intl: string; hnsg: string; other: string; total: string; po_total: string; estimate: boolean }[]>`
    SELECT COALESCE(SUM(purchase_vnd), 0)::text AS purchase, COALESCE(SUM(us_domestic_vnd), 0)::text AS us,
           COALESCE(SUM(international_vnd), 0)::text AS intl, COALESCE(SUM(hn_sg_vnd), 0)::text AS hnsg,
           COALESCE(SUM(other_vnd), 0)::text AS other, COALESCE(SUM(landed_cost_vnd), 0)::text AS total,
           (SELECT COALESCE(SUM(total_vnd), 0)::text FROM purchase_orders WHERE batch_id = ${batchId} AND deleted_at IS NULL) AS po_total,
           COALESCE(bool_or(has_estimate), false) AS estimate
      FROM v_item_landed_cost WHERE batch_id = ${batchId}`;
  return {
    purchaseVnd: BigInt(r.purchase),
    usDomesticVnd: BigInt(r.us),
    internationalVnd: BigInt(r.intl),
    hnSgVnd: BigInt(r.hnsg),
    otherVnd: BigInt(r.other),
    totalVnd: BigInt(r.total),
    /** Σ total_vnd các đơn mua — so với nhóm A để đối soát */
    purchaseOrdersVnd: BigInt(r.po_total),
    hasEstimate: r.estimate,
  };
}

/** Đối tượng có thể gắn chi phí của một chuyến: chuyến, các đơn mua, các kiện có máy của chuyến. */
export async function costTargets(db: Db, batchId: string) {
  const [b] = await db<{ code: string }[]>`SELECT code FROM batches WHERE id = ${batchId}`;
  const pos = await db<{ id: string; label: string }[]>`
    SELECT po.id::text, s.name || COALESCE(' · ' || po.order_number, '') AS label
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.batch_id = ${batchId} AND po.deleted_at IS NULL ORDER BY po.ordered_at`;
  const ships = await db<{ id: string; label: string; leg: string }[]>`
    SELECT DISTINCT sh.id::text, COALESCE(sh.tracking_number, sh.reference_code, '(chưa có mã)') AS label, sh.leg_type::text AS leg
      FROM shipments sh JOIN shipment_items si ON si.shipment_id = sh.id JOIN items i ON i.id = si.item_id
     WHERE i.batch_id = ${batchId} AND i.deleted_at IS NULL`;
  return { batchCode: b?.code ?? "", purchaseOrders: pos, shipments: ships };
}
