/**
 * Dịch vụ Kiện / chặng vận chuyển (tài liệu 01 mục 4, tài liệu 04 mục 4).
 *
 * - Gán máy vào kiện bằng quét / dán Serial, IMEI; mỗi máy chỉ thuộc 1 kiện trên mỗi chặng.
 * - "Gửi đi" / "Đã nhận" trên kiện → mốc (item_events) + trạng thái cho MỌI máy trong kiện, cùng 1 transaction.
 * - Đổi máy trong kiện làm đổi cách chia cước của kiện → tính lại giá vốn các chuyến liên quan (chuyến đã chốt → chặn).
 * - Chuyến tự chuyển trạng thái theo máy: có máy đang đi → "Đang vận chuyển"; mọi máy đã về SG → "Đã về".
 */
import type { Sql, TransactionSql } from "postgres";
import { variantLabel } from "@/domain/catalog";
import { checkReceipt, shortageNote } from "@/domain/receiving";
import { etaFrom, isMainLeg, LEG_RULES, nextItemStatus, OUT_OF_FLOW, type ShipmentInput } from "@/domain/shipping";
import { recalculateBatches, type RecalcResult } from "@/server/costing/service";

type Db = Sql | TransactionSql;

export type ShippingErrorCode = "NOT_FOUND" | "INVALID_STATE" | "INVALID_INPUT" | "IN_USE";

export class ShippingError extends Error {
  constructor(
    readonly code: ShippingErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ShippingError";
  }
}

async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", id: string, before: unknown, after: unknown) {
  await tx`
    INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
    VALUES (${action}, 'shipment', ${id}, ${before == null ? null : tx.json(before as never)}, ${after == null ? null : tx.json(after as never)})`;
}

// ---- Đọc ------------------------------------------------------------------------------------------------

export interface ShipmentRow {
  id: string;
  legType: string;
  status: string;
  carrierId: string | null;
  carrierName: string | null;
  trackingTemplate: string | null;
  trackingNumber: string | null;
  referenceCode: string | null;
  batchId: string | null;
  batchCodes: string[];
  shippedAt: string | null;
  eta: string | null;
  arrivedAt: string | null;
  chargeableWeightKg: string | null;
  note: string | null;
  itemCount: number;
  valueVnd: bigint;
  costCount: number;
  labelCreatedAt: string | null;
  trackEnabled: boolean;
  trackStatus: string | null;
  trackStatusText: string | null;
  trackEta: string | null;
  trackEtaWindow: string | null;
  trackPickedUpAt: string | null;
  trackDeliveredAt: string | null;
  trackCheckedAt: string | null;
  trackError: string | null;
}

const SHIPMENT_SELECT = (db: Db) => db`
  SELECT s.id::text, s.leg_type::text AS leg_type, s.status::text, s.carrier_id::text, c.name AS carrier_name,
         c.tracking_url_template AS tpl, s.tracking_number, s.reference_code, s.batch_id::text,
         s.shipped_at::text, s.eta::text, s.arrived_at::text, s.chargeable_weight_kg::text AS weight, s.note,
         COALESCE(x.n, 0)::int AS item_count, COALESCE(x.value, 0)::text AS value, COALESCE(x.batches, '{}') AS batch_codes,
         (SELECT COUNT(*)::int FROM costs k WHERE k.shipment_id = s.id AND k.deleted_at IS NULL) AS cost_count,
         to_json(s.label_created_at)#>>'{}' AS label_created_at, s.track_enabled, s.track_status, s.track_status_text, s.track_eta::text,
         s.track_eta_window, to_json(s.track_picked_up_at)#>>'{}' AS track_picked_up_at, to_json(s.track_delivered_at)#>>'{}' AS track_delivered_at,
         to_json(s.track_checked_at)#>>'{}' AS track_checked_at, s.track_error
    FROM shipments s
    LEFT JOIN carriers c ON c.id = s.carrier_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n, SUM(lc.landed_cost_vnd) AS value, array_agg(DISTINCT b.code ORDER BY b.code) AS batches
        FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL
        JOIN batches b ON b.id = i.batch_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
       WHERE si.shipment_id = s.id
    ) x ON true`;

type RawShipment = {
  id: string;
  leg_type: string;
  status: string;
  carrier_id: string | null;
  carrier_name: string | null;
  tpl: string | null;
  tracking_number: string | null;
  reference_code: string | null;
  batch_id: string | null;
  shipped_at: string | null;
  eta: string | null;
  arrived_at: string | null;
  weight: string | null;
  note: string | null;
  item_count: number;
  value: string;
  batch_codes: string[];
  cost_count: number;
  label_created_at: string | null;
  track_enabled: boolean;
  track_status: string | null;
  track_status_text: string | null;
  track_eta: string | null;
  track_eta_window: string | null;
  track_picked_up_at: string | null;
  track_delivered_at: string | null;
  track_checked_at: string | null;
  track_error: string | null;
};

const toRow = (r: RawShipment): ShipmentRow => ({
  id: r.id,
  legType: r.leg_type,
  status: r.status,
  carrierId: r.carrier_id,
  carrierName: r.carrier_name,
  trackingTemplate: r.tpl,
  trackingNumber: r.tracking_number,
  referenceCode: r.reference_code,
  batchId: r.batch_id,
  batchCodes: r.batch_codes,
  shippedAt: r.shipped_at,
  eta: r.eta,
  arrivedAt: r.arrived_at,
  chargeableWeightKg: r.weight,
  note: r.note,
  itemCount: r.item_count,
  valueVnd: BigInt(r.value),
  costCount: r.cost_count,
  labelCreatedAt: r.label_created_at,
  trackEnabled: r.track_enabled,
  trackStatus: r.track_status,
  trackStatusText: r.track_status_text,
  trackEta: r.track_eta,
  trackEtaWindow: r.track_eta_window,
  trackPickedUpAt: r.track_picked_up_at,
  trackDeliveredAt: r.track_delivered_at,
  trackCheckedAt: r.track_checked_at,
  trackError: r.track_error,
});

/** Kiện cho bảng tiến độ: chưa nhận + đã nhận trong `arrivedWithinDays` ngày gần đây. */
export async function listShipments(db: Db, arrivedWithinDays = 30): Promise<ShipmentRow[]> {
  const rows = await db<RawShipment[]>`
    SELECT * FROM (${SHIPMENT_SELECT(db)}) q
     WHERE q.status NOT IN ('ARRIVED', 'CANCELLED') OR q.arrived_at::timestamptz > now() - make_interval(days => ${arrivedWithinDays})
     ORDER BY q.eta NULLS LAST, q.shipped_at NULLS LAST, q.id`;
  return rows.map(toRow);
}

export interface ShipmentItem {
  id: string;
  label: string;
  serial: string | null;
  imei1: string | null;
  imei2: string | null;
  status: string;
  batchId: string;
  batchCode: string;
  landedCostVnd: bigint;
}

export async function getShipment(db: Db, id: string): Promise<(ShipmentRow & { items: ShipmentItem[] }) | null> {
  const [r] = await db<RawShipment[]>`SELECT * FROM (${SHIPMENT_SELECT(db)}) q WHERE q.id = ${id}`;
  if (!r) return null;
  const items = await db<
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
      imei2: string | null;
      status: string;
      batch_id: string;
      batch_code: string;
      landed: string;
    }[]
  >`
    SELECT i.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity, i.serial_number, i.imei1, i.imei2,
           i.status::text, i.batch_id::text, b.code AS batch_code, lc.landed_cost_vnd::text AS landed
      FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN batches b ON b.id = i.batch_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
     WHERE si.shipment_id = ${id}
     ORDER BY b.code, i.created_at, i.id`;
  return {
    ...toRow(r),
    items: items.map((i) => ({
      id: i.id,
      label: variantLabel(i.model, i),
      serial: i.serial_number,
      imei1: i.imei1,
      imei2: i.imei2,
      status: i.status,
      batchId: i.batch_id,
      batchCode: i.batch_code,
      landedCostVnd: BigInt(i.landed),
    })),
  };
}

export async function shippingOptions(db: Db) {
  const carriers = await db<{ id: string; name: string; legs: string; lead: number | null }[]>`
    SELECT id::text, name, leg_types::text AS legs, default_lead_days AS lead FROM carriers ORDER BY name`;
  const batches = await db<{ id: string; code: string }[]>`
    SELECT id::text, code FROM batches WHERE deleted_at IS NULL AND status NOT IN ('CLOSED') ORDER BY created_at DESC LIMIT 50`;
  return {
    carriers: carriers.map((c) => ({ id: c.id, name: c.name, legTypes: c.legs.replace(/[{}]/g, "").split(",").filter(Boolean), leadDays: c.lead })),
    batches,
  };
}

// ---- Tạo / sửa / xoá kiện -------------------------------------------------------------------------------

async function checkRefs(tx: TransactionSql, input: ShipmentInput) {
  if (input.carrierId) {
    const [c] = await tx<{ legs: string }[]>`SELECT leg_types::text AS legs FROM carriers WHERE id = ${input.carrierId}`;
    if (!c) throw new ShippingError("NOT_FOUND", "Không tìm thấy đơn vị vận chuyển", "carrierId");
    if (!c.legs.replace(/[{}]/g, "").split(",").includes(input.legType))
      throw new ShippingError("INVALID_INPUT", "Đơn vị vận chuyển này không phục vụ chặng đã chọn (sửa ở Danh mục → Vận chuyển)", "carrierId");
  }
  if (input.batchId) {
    const [b] = await tx`SELECT 1 FROM batches WHERE id = ${input.batchId} AND deleted_at IS NULL`;
    if (!b) throw new ShippingError("NOT_FOUND", "Không tìm thấy chuyến", "batchId");
  }
}

export async function createShipment(db: Db, input: ShipmentInput): Promise<string> {
  return db.begin(async (tx) => {
    await checkRefs(tx, input);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO shipments (leg_type, carrier_id, batch_id, tracking_number, reference_code, eta, chargeable_weight_kg, note)
      VALUES (${input.legType}, ${input.carrierId}, ${input.batchId}, ${input.trackingNumber}, ${input.referenceCode}, ${input.eta},
              ${input.chargeableWeightKg}, ${input.note})
      RETURNING id::text`;
    await audit(tx, "CREATE", row.id, null, input);
    return row.id;
  });
}

export async function updateShipment(db: Db, id: string, input: Omit<ShipmentInput, "legType">) {
  return db.begin(async (tx) => {
    const [before] = await tx<{ leg_type: string }[]>`SELECT leg_type::text, carrier_id::text, batch_id::text, tracking_number, reference_code, eta::text,
      chargeable_weight_kg::text, note FROM shipments WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new ShippingError("NOT_FOUND", "Không tìm thấy kiện");
    await checkRefs(tx, { ...input, legType: before.leg_type as ShipmentInput["legType"] });
    await tx`
      UPDATE shipments SET carrier_id = ${input.carrierId}, batch_id = ${input.batchId}, tracking_number = ${input.trackingNumber},
             reference_code = ${input.referenceCode}, eta = ${input.eta}, chargeable_weight_kg = ${input.chargeableWeightKg}, note = ${input.note},
             updated_at = now()
       WHERE id = ${id}`;
    await audit(tx, "UPDATE", id, before, input);
  });
}

export async function deleteShipment(db: Db, id: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, id);
    if (s.status !== "PLANNED") throw new ShippingError("INVALID_STATE", "Kiện đã gửi đi — không xoá được (có mốc thời gian của máy)");
    const [c] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM costs WHERE shipment_id = ${id} AND deleted_at IS NULL`;
    if (c.n) throw new ShippingError("IN_USE", `Kiện có ${c.n} khoản chi phí — xoá chi phí trước`);
    const batches = await batchesOf(tx, id);
    await tx`DELETE FROM shipments WHERE id = ${id}`; // shipment_items xoá theo (ON DELETE CASCADE)
    await audit(tx, "DELETE", id, s, null);
    if (batches.length) await recalculateBatches(tx, batches);
  });
}

// ---- Gán máy --------------------------------------------------------------------------------------------

export interface AssignResult {
  added: { id: string; code: string }[];
  /** mã không gán được + lý do (không chặn các mã khác) */
  rejected: { code: string; reason: string }[];
  recalc: RecalcResult | null;
}

/**
 * Gán máy vào kiện theo danh sách mã quét / dán (Serial, IMEI 1, IMEI 2). Mã lỗi được báo riêng, mã đúng vẫn gán.
 * Kiện đã gửi đi mà thêm máy → máy cũng nhận mốc "gửi đi" của kiện.
 */
export async function assignItems(db: Db, shipmentId: string, codes: readonly string[]): Promise<AssignResult> {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (s.status === "ARRIVED" || s.status === "CANCELLED" || s.status === "LOST")
      throw new ShippingError("INVALID_STATE", "Kiện đã nhận / đã huỷ — không thêm máy được");
    const found = await tx<{ id: string; serial_number: string | null; imei1: string | null; imei2: string | null; status: string; batch_id: string }[]>`
      SELECT id::text, serial_number, imei1, imei2, status::text, batch_id::text FROM items
       WHERE deleted_at IS NULL AND (serial_number = ANY(${codes}) OR imei1 = ANY(${codes}) OR imei2 = ANY(${codes}))`;
    const inLeg = await tx<{ item_id: string; shipment_id: string; tracking: string | null }[]>`
      SELECT si.item_id::text, si.shipment_id::text, COALESCE(sh.tracking_number, sh.reference_code) AS tracking
        FROM shipment_items si JOIN shipments sh ON sh.id = si.shipment_id
       WHERE si.leg_type = ${s.leg_type} AND si.item_id = ANY(${found.map((f) => f.id)}::uuid[])`;
    const added: AssignResult["added"] = [];
    const rejected: AssignResult["rejected"] = [];
    const seen = new Set<string>();
    for (const code of codes) {
      const item = found.find((f) => f.serial_number === code || f.imei1 === code || f.imei2 === code);
      if (!item) {
        rejected.push({ code, reason: "Không có máy nào có Serial/IMEI này (nhập máy ở Chuyến hàng trước)" });
        continue;
      }
      if (seen.has(item.id)) continue; // quét cả Serial lẫn IMEI của cùng 1 máy
      seen.add(item.id);
      const other = inLeg.find((x) => x.item_id === item.id);
      if (other) {
        rejected.push({
          code,
          reason: other.shipment_id === shipmentId ? "Đã có trong kiện này" : `Đã nằm trong kiện ${other.tracking ?? "khác"} cùng chặng`,
        });
        continue;
      }
      if ((OUT_OF_FLOW as readonly string[]).includes(item.status)) {
        rejected.push({ code, reason: `Máy đang ở trạng thái không đi tiếp được (${item.status})` });
        continue;
      }
      await tx`INSERT INTO shipment_items (shipment_id, leg_type, item_id) VALUES (${shipmentId}, ${s.leg_type}, ${item.id})`;
      added.push({ id: item.id, code });
    }
    if (added.length && s.status !== "PLANNED" && isMainLeg(s.leg_type) && s.shipped_at) {
      await applyEvent(
        tx,
        s.leg_type,
        "depart",
        shipmentId,
        s.shipped_at,
        added.map((a) => a.id),
      );
    }
    const batches = await batchesOf(tx, shipmentId);
    const recalc = added.length ? await recalculateBatches(tx, batches) : null;
    if (added.length) {
      await syncBatchStatus(tx, batches);
      await audit(tx, "UPDATE", shipmentId, null, { addedItems: added });
    }
    return { added, rejected, recalc };
  });
}

/** Bỏ máy khỏi kiện — chỉ khi kiện chưa gửi đi. */
export async function removeItem(db: Db, shipmentId: string, itemId: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (s.status !== "PLANNED") throw new ShippingError("INVALID_STATE", "Kiện đã gửi đi — không bỏ máy ra được (máy đã có mốc theo kiện)");
    const batches = await batchesOf(tx, shipmentId);
    const [row] = await tx`DELETE FROM shipment_items WHERE shipment_id = ${shipmentId} AND item_id = ${itemId} RETURNING 1`;
    if (!row) throw new ShippingError("NOT_FOUND", "Máy không có trong kiện");
    await audit(tx, "UPDATE", shipmentId, { removedItem: itemId }, null);
    return recalculateBatches(tx, batches);
  });
}

// ---- Gửi đi / Đã nhận / Giữ hải quan ------------------------------------------------------------------

/** "Gửi đi": mốc M2/M4/M6 cho mọi máy, trạng thái đi tới, ETA tự tính nếu trống. `at` = ISO (cho phép nhập bù ngày cũ). */
export async function markShipped(db: Db, id: string, at: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, id);
    if (s.status !== "PLANNED") throw new ShippingError("INVALID_STATE", `Kiện đang ở trạng thái "${s.status}" — chỉ kiện chờ gửi mới bấm "Gửi đi"`);
    const items = await itemIds(tx, id);
    if (!items.length) throw new ShippingError("INVALID_STATE", "Kiện chưa có máy nào — quét máy vào kiện trước");
    if (s.label_ms && Date.parse(at) < Number(s.label_ms)) throw new ShippingError("INVALID_INPUT", "Giờ gửi đi không được trước giờ người bán tạo nhãn", "at");
    const eta = s.eta ?? etaFrom(at, s.lead_days);
    await tx`UPDATE shipments SET status = 'IN_TRANSIT', shipped_at = ${at}, eta = ${eta}, updated_at = now() WHERE id = ${id}`;
    if (isMainLeg(s.leg_type)) await applyEvent(tx, s.leg_type, "depart", id, at, items);
    await audit(tx, "UPDATE", id, { status: s.status }, { status: "IN_TRANSIT", shippedAt: at, eta });
    await syncBatchStatus(tx, await batchesOf(tx, id));
    return { itemCount: items.length, eta };
  });
}

/** "Đã nhận": mốc M3/M5/M7 cho mọi máy (về SG → tồn kho, khách cọc giữ "Khách cọc"). */
export async function markArrived(db: Db, id: string, at: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, id);
    if (s.status !== "IN_TRANSIT" && s.status !== "HOLD") throw new ShippingError("INVALID_STATE", 'Chỉ kiện đang đi mới bấm "Đã nhận" — bấm "Gửi đi" trước');
    if (s.shipped_ms && Date.parse(at) < Number(s.shipped_ms)) throw new ShippingError("INVALID_INPUT", "Ngày nhận không được trước ngày gửi", "at");
    const items = await itemIds(tx, id);
    await tx`UPDATE shipments SET status = 'ARRIVED', arrived_at = ${at}, updated_at = now() WHERE id = ${id}`;
    if (isMainLeg(s.leg_type)) await applyEvent(tx, s.leg_type, "arrive", id, at, items);
    await audit(tx, "UPDATE", id, { status: s.status }, { status: "ARRIVED", arrivedAt: at });
    await syncBatchStatus(tx, await batchesOf(tx, id));
    return { itemCount: items.length };
  });
}

/** Giữ hải quan / hết giữ (trạng thái ở cấp kiện, không đổi trạng thái máy). */
export async function setHold(db: Db, id: string, hold: boolean, note?: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, id);
    if (hold && s.status !== "IN_TRANSIT") throw new ShippingError("INVALID_STATE", "Chỉ kiện đang đi mới đánh dấu giữ hải quan được");
    if (!hold && s.status !== "HOLD") throw new ShippingError("INVALID_STATE", "Kiện không ở trạng thái giữ hải quan");
    const next = hold ? "HOLD" : "IN_TRANSIT";
    await tx`UPDATE shipments SET status = ${next}, updated_at = now() WHERE id = ${id}`;
    await tx`
      INSERT INTO shipment_tracking_events (shipment_id, occurred_at, description)
      VALUES (${id}, now(), ${hold ? `Bị giữ hải quan${note ? `: ${note}` : ""}` : "Hết giữ hải quan"})`;
    await audit(tx, "UPDATE", id, { status: s.status }, { status: next, note: note ?? null });
  });
}

// ---- Nhận kiện bằng quét đối chiếu (tài liệu 07 mục 5.1) -----------------------------------------------

export interface ReceiveResult {
  received: number;
  missing: { id: string; code: string }[];
  /** mã quét không thuộc kiện + máy đó đang ở đâu (nếu có trong hệ thống) */
  outside: { code: string; reason: string }[];
}

/**
 * "Xác nhận nhận" sau khi quét: máy ✓ nhận mốc về (M3/M5/M7) và trạng thái tới; máy chưa quét GIỮ NGUYÊN trạng thái
 * đang vận chuyển và kiện ghi sự cố thiếu hàng. Kiện chuyển "Đã nhận". Còn thiếu mà chưa xác nhận `acceptShortage` → chặn,
 * không ghi gì (tránh bấm nhầm khi mới quét được một phần).
 */
export async function receiveByScan(db: Db, id: string, codes: readonly string[], at: string, acceptShortage: boolean): Promise<ReceiveResult> {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, id);
    if (s.status !== "IN_TRANSIT" && s.status !== "HOLD") throw new ShippingError("INVALID_STATE", 'Chỉ kiện đang đi mới nhận được — bấm "Gửi đi" trước');
    if (s.shipped_ms && Date.parse(at) < Number(s.shipped_ms)) throw new ShippingError("INVALID_INPUT", "Ngày nhận không được trước ngày gửi", "at");
    const expected = await tx<{ id: string; label: string; serial: string | null; imei1: string | null; imei2: string | null }[]>`
      SELECT i.id::text, i.id::text AS label, i.serial_number AS serial, i.imei1, i.imei2
        FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL
       WHERE si.shipment_id = ${id} ORDER BY i.created_at, i.id`;
    if (!expected.length) throw new ShippingError("INVALID_STATE", "Kiện không có máy nào");
    const chk = checkReceipt(expected, codes);
    if (!chk.matched.length) throw new ShippingError("INVALID_INPUT", "Chưa quét được máy nào thuộc kiện này", "codes");
    if (chk.missing.length && !acceptShortage)
      throw new ShippingError(
        "INVALID_STATE",
        `Còn thiếu ${chk.missing.length} máy chưa quét — quét tiếp, hoặc tích "Nhận phần đã quét, ghi sự cố thiếu hàng" rồi xác nhận lại`,
        "acceptShortage",
      );
    await tx`UPDATE shipments SET status = 'ARRIVED', arrived_at = ${at}, updated_at = now() WHERE id = ${id}`;
    if (isMainLeg(s.leg_type))
      await applyEvent(
        tx,
        s.leg_type,
        "arrive",
        id,
        at,
        chk.matched.map((m) => m.id),
      );
    const missing = chk.missing.map((m) => ({ id: m.id, code: m.serial ?? m.imei1 ?? m.imei2 ?? m.id }));
    if (missing.length) {
      const note = shortageNote(chk.missing.map((m) => ({ ...m, label: m.serial ?? m.imei1 ?? "máy chưa có mã" })));
      await tx`INSERT INTO shipment_tracking_events (shipment_id, occurred_at, description) VALUES (${id}, ${at}, ${note})`;
      for (const m of missing)
        await tx`INSERT INTO item_events (item_id, event_type, occurred_at, shipment_id, note)
                 VALUES (${m.id}, 'NOTE', ${at}, ${id}, 'Thiếu khi nhận kiện — chưa về tới nơi')`;
    }
    const outside = await whereAre(tx, s.leg_type, id, chk.outside);
    await audit(
      tx,
      "UPDATE",
      id,
      { status: s.status },
      { status: "ARRIVED", arrivedAt: at, byScan: true, received: chk.matched.length, missing: missing.map((m) => m.code), outside: chk.outside },
    );
    await syncBatchStatus(tx, await batchesOf(tx, id));
    return { received: chk.matched.length, missing, outside };
  });
}

/** Mã quét ngoài kiện → lý do dễ hiểu (máy nằm kiện khác cùng chặng / không thuộc kiện nào / chưa có trong hệ thống). */
async function whereAre(tx: TransactionSql, leg: string, shipmentId: string, codes: string[]) {
  if (!codes.length) return [];
  const rows = await tx<{ serial_number: string | null; imei1: string | null; imei2: string | null; tracking: string | null; sid: string | null }[]>`
    SELECT i.serial_number, i.imei1, i.imei2, COALESCE(sh.tracking_number, sh.reference_code) AS tracking, sh.id::text AS sid
      FROM items i
      LEFT JOIN shipment_items si ON si.item_id = i.id AND si.leg_type = ${leg}
      LEFT JOIN shipments sh ON sh.id = si.shipment_id
     WHERE i.deleted_at IS NULL AND (i.serial_number = ANY(${codes}) OR i.imei1 = ANY(${codes}) OR i.imei2 = ANY(${codes}))`;
  return codes.map((code) => {
    const r = rows.find((x) => x.serial_number === code || x.imei1 === code || x.imei2 === code);
    if (!r) return { code, reason: "Chưa có trong hệ thống (máy chưa nhập, hoặc mã đọc sai)" };
    if (r.sid && r.sid !== shipmentId) return { code, reason: `Thuộc kiện ${r.tracking ?? "khác"} cùng chặng — có thể gửi nhầm kiện` };
    return { code, reason: "Không nằm trong kiện nào của chặng này" };
  });
}

export interface ShortageRow {
  itemId: string;
  label: string;
  serial: string | null;
  imei1: string | null;
  status: string;
  shipmentId: string;
  tracking: string | null;
  arrivedAt: string | null;
}

/**
 * Sự cố thiếu hàng còn mở: máy nằm trong kiện ĐÃ NHẬN (3 chặng chính) nhưng chưa có mốc về của kiện đó
 * và vẫn đang trên đường (chưa bán / thất lạc / …). `shipmentId` = chỉ của 1 kiện.
 */
export async function listShortages(db: Db, shipmentId?: string): Promise<ShortageRow[]> {
  const rows = await db<
    {
      item_id: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      serial_number: string | null;
      imei1: string | null;
      status: string;
      shipment_id: string;
      tracking: string | null;
      arrived_at: string | null;
    }[]
  >`
    SELECT i.id::text AS item_id, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity, i.serial_number, i.imei1, i.status::text,
           s.id::text AS shipment_id, COALESCE(s.tracking_number, s.reference_code) AS tracking, s.arrived_at::text
      FROM shipments s
      JOIN shipment_items si ON si.shipment_id = s.id
      JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
     WHERE s.status = 'ARRIVED' AND s.leg_type IN ('US_DOMESTIC', 'US_TO_VN', 'HN_TO_SG')
       AND (${shipmentId ?? null}::uuid IS NULL OR s.id = ${shipmentId ?? null}::uuid)
       AND i.status::text <> ALL(${[...OUT_OF_FLOW]}::text[])
       AND NOT EXISTS (
         SELECT 1 FROM item_events e
          WHERE e.item_id = i.id AND e.shipment_id = s.id
            AND e.event_type::text = CASE s.leg_type WHEN 'US_DOMESTIC' THEN 'US_WAREHOUSE_RECEIVED' WHEN 'US_TO_VN' THEN 'HN_ARRIVED' ELSE 'SG_RECEIVED' END)
     ORDER BY s.arrived_at DESC, i.created_at, i.id`;
  return rows.map((r) => ({
    itemId: r.item_id,
    label: variantLabel(r.model, r),
    serial: r.serial_number,
    imei1: r.imei1,
    status: r.status,
    shipmentId: r.shipment_id,
    tracking: r.tracking,
    arrivedAt: r.arrived_at,
  }));
}

/** Máy thiếu đã tìm thấy / về sau → nhận bổ sung: mốc về của kiện cho riêng máy đó, đóng sự cố. */
export async function receiveLateItem(db: Db, shipmentId: string, itemId: string, at: string) {
  return db.begin(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (s.status !== "ARRIVED" || !isMainLeg(s.leg_type)) throw new ShippingError("INVALID_STATE", "Kiện chưa nhận — dùng nút nhận kiện");
    const open = await listShortages(tx, shipmentId);
    if (!open.some((o) => o.itemId === itemId)) throw new ShippingError("NOT_FOUND", "Máy không nằm trong danh sách thiếu của kiện này");
    if (s.shipped_ms && Date.parse(at) < Number(s.shipped_ms)) throw new ShippingError("INVALID_INPUT", "Ngày nhận không được trước ngày gửi", "at");
    await applyEvent(tx, s.leg_type, "arrive", shipmentId, at, [itemId]);
    await tx`INSERT INTO shipment_tracking_events (shipment_id, occurred_at, description)
             SELECT ${shipmentId}, ${at}, 'Nhận bổ sung máy thiếu: ' || COALESCE(serial_number, imei1, id::text) FROM items WHERE id = ${itemId}`;
    await audit(tx, "UPDATE", shipmentId, null, { receivedLate: itemId, at });
    await syncBatchStatus(tx, await batchesOf(tx, shipmentId));
  });
}

// ---- Nội bộ ---------------------------------------------------------------------------------------------

async function lockShipment(tx: TransactionSql, id: string) {
  const [s] = await tx<
    {
      status: string;
      leg_type: string;
      shipped_at: string | null;
      shipped_ms: string | null;
      label_ms: string | null;
      eta: string | null;
      lead_days: number | null;
    }[]
  >`
    SELECT s.status::text, s.leg_type::text, s.shipped_at::text, (extract(epoch FROM s.shipped_at) * 1000)::bigint::text AS shipped_ms,
           (extract(epoch FROM s.label_created_at) * 1000)::bigint::text AS label_ms, s.eta::text,
           c.default_lead_days AS lead_days
      FROM shipments s LEFT JOIN carriers c ON c.id = s.carrier_id WHERE s.id = ${id} FOR UPDATE OF s`;
  if (!s) throw new ShippingError("NOT_FOUND", "Không tìm thấy kiện");
  return s;
}

async function itemIds(tx: TransactionSql, shipmentId: string) {
  return (
    await tx<{ id: string }[]>`
      SELECT i.id::text FROM shipment_items si JOIN items i ON i.id = si.item_id AND i.deleted_at IS NULL WHERE si.shipment_id = ${shipmentId}`
  ).map((r) => r.id);
}

async function batchesOf(tx: TransactionSql, shipmentId: string) {
  return (
    await tx<{ id: string }[]>`
      SELECT DISTINCT i.batch_id::text AS id FROM shipment_items si JOIN items i ON i.id = si.item_id WHERE si.shipment_id = ${shipmentId}`
  ).map((r) => r.id);
}

/** Ghi mốc + chuyển trạng thái (chỉ đi tới) cho các máy. */
async function applyEvent(tx: TransactionSql, leg: keyof typeof LEG_RULES, kind: "depart" | "arrive", shipmentId: string, at: string, items: string[]) {
  const rule = LEG_RULES[leg];
  const event = kind === "depart" ? rule.departEvent : rule.arriveEvent;
  const target = kind === "depart" ? rule.inTransit : rule.arrived;
  for (const itemId of items) {
    const [ev] = await tx`SELECT 1 FROM item_events WHERE item_id = ${itemId} AND event_type = ${event} AND shipment_id = ${shipmentId}`;
    if (!ev) await tx`INSERT INTO item_events (item_id, event_type, occurred_at, shipment_id) VALUES (${itemId}, ${event}, ${at}, ${shipmentId})`;
  }
  const rows = await tx<{ id: string; status: string }[]>`SELECT id::text, status::text FROM items WHERE id = ANY(${items}::uuid[]) FOR UPDATE`;
  for (const r of rows) {
    const next = nextItemStatus(r.status, target);
    if (next) await tx`UPDATE items SET status = ${next}, updated_at = now() WHERE id = ${r.id}`;
  }
}

/**
 * Trạng thái chuyến theo máy (không đụng chuyến đã chốt / đã đóng):
 * có máy đang trên đường (đã gửi ít nhất 1 chặng) → IN_TRANSIT; mọi máy đã về SG hoặc đã xử lý → ARRIVED.
 */
async function syncBatchStatus(tx: TransactionSql, batchIds: string[]) {
  if (!batchIds.length) return;
  await tx`
    UPDATE batches b SET status = x.next, updated_at = now()
      FROM (
        SELECT i.batch_id,
               CASE WHEN bool_and(i.status::text NOT IN ('ORDERED','US_IN_TRANSIT','AT_US_WAREHOUSE','INTL_IN_TRANSIT','AT_HN','DOMESTIC_IN_TRANSIT')
                                  AND (i.status <> 'RESERVED' OR EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event_type = 'SG_RECEIVED')))
                    THEN 'ARRIVED'
                    WHEN bool_or(i.status::text IN ('US_IN_TRANSIT','AT_US_WAREHOUSE','INTL_IN_TRANSIT','AT_HN','DOMESTIC_IN_TRANSIT')
                                 OR EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.event_type = 'SELLER_SHIPPED'))
                    THEN 'IN_TRANSIT'
               END::batch_status AS next
          FROM items i WHERE i.batch_id = ANY(${batchIds}::uuid[]) AND i.deleted_at IS NULL GROUP BY i.batch_id
      ) x
     WHERE b.id = x.batch_id AND x.next IS NOT NULL AND b.status NOT IN ('COSTS_FINALIZED', 'CLOSED') AND b.status <> x.next`;
}
