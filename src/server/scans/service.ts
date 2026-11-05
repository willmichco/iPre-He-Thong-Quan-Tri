/**
 * Hộp chờ duyệt: nhận kết quả quét từ điện thoại (scan_captures, PENDING_REVIEW), soát từng dòng, sửa, bỏ,
 * xác nhận vào đơn mua (tạo máy — cùng kiểm tra như lưới nhập máy) hoặc vào kiện (nhận hàng theo Serial / IMEI).
 * Dòng đã xác nhận ghi item_id + reviewed_at; dòng bỏ → DISCARDED. Mọi thao tác ghi nhật ký.
 */
import type { Sql, TransactionSql } from "postgres";
import { variantLabel } from "@/domain/catalog";
import { codesOf, reviewCapture, scanSourceOf, type InboxField, type InboxRecord, type InboxSource, type Level, type ReviewIssue } from "@/domain/scan-inbox";
import { emptyRow, type GridRow } from "@/domain/purchasing-core";
import { appendItems } from "@/server/purchasing/service";
import { assignItems } from "@/server/shipping/service";

type Db = Sql | TransactionSql;

export class ScanInboxError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_INPUT",
    message: string,
    readonly field?: string,
    readonly rowErrors?: { id: string; message: string }[],
  ) {
    super(message);
    this.name = "ScanInboxError";
  }
}

interface Extracted {
  fields: InboxRecord["fields"];
  extras: string[];
  note: string | null;
  origin: string;
  clientId: string;
}

/** Ghi các bản ghi quét vào hộp chờ. Bản ghi đã gửi trước đó (cùng mã trên thiết bị) và còn chờ duyệt → bỏ qua. */
export async function submitCaptures(db: Db, records: readonly InboxRecord[]): Promise<{ added: number; skipped: number }> {
  if (!records.length) throw new ScanInboxError("INVALID_INPUT", "Phiên quét chưa có máy nào");
  return db.begin(async (tx) => {
    const ids = records.map((r) => r.clientId).filter(Boolean);
    const already = new Set(
      ids.length
        ? (
            await tx<{ c: string }[]>`
              SELECT extracted->>'clientId' AS c FROM scan_captures WHERE status = 'PENDING_REVIEW' AND extracted->>'clientId' = ANY(${ids})`
          ).map((r) => r.c)
        : [],
    );
    let added = 0;
    for (const r of records) {
      if (r.clientId && already.has(r.clientId)) continue;
      const extracted: Extracted = { fields: r.fields, extras: r.extras, note: r.note, origin: r.origin, clientId: r.clientId };
      const barcodes = Object.values(r.fields)
        .filter((f) => f.source === "BARCODE" || f.source === "HW_SCANNER")
        .map((f) => ({ text: f.value }));
      await tx`
        INSERT INTO scan_captures (source, context_type, barcodes, extracted, created_at)
        VALUES (${scanSourceOf(r.origin)}, 'INBOX', ${tx.json(barcodes)}, ${tx.json(extracted as never)}, clock_timestamp())`;
      added++;
    }
    if (added) await tx`INSERT INTO audit_logs (action, entity_type, after) VALUES ('CREATE', 'scan_capture', ${tx.json({ submitted: added })})`;
    return { added, skipped: records.length - added };
  });
}

export interface InboxRow {
  id: string;
  createdAt: string;
  source: string;
  fields: InboxRecord["fields"];
  extras: string[];
  note: string | null;
  variant: { id: string; label: string } | null;
  level: Level;
  issues: ReviewIssue[];
  /** máy đã có khớp mã (để nhận kiện) */
  existingItemIds: string[];
}

export async function listInbox(db: Db): Promise<InboxRow[]> {
  const rows = await db<{ id: string; created_at: string; source: string; extracted: Extracted }[]>`
    SELECT id::text, to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS created_at, source::text, extracted
      FROM scan_captures WHERE status = 'PENDING_REVIEW' ORDER BY scan_captures.created_at, scan_captures.id`; // cột thật, không phải chuỗi đã định dạng
  if (!rows.length) return [];
  const parts = [...new Set(rows.flatMap((r) => (r.extracted.fields?.partNumber?.value ? [r.extracted.fields.partNumber.value] : [])))];
  const codes = [...new Set(rows.flatMap((r) => codesOf(r.extracted.fields ?? {})))];
  const [variants, existing, region] = await Promise.all([
    parts.length
      ? db<
          {
            code: string;
            id: string;
            model: string;
            storage: string | null;
            color: string | null;
            chip: string | null;
            memory: string | null;
            connectivity: string | null;
          }[]
        >`
          SELECT vc.code, v.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity
            FROM variant_codes vc JOIN product_variants v ON v.id = vc.variant_id JOIN product_models m ON m.id = v.model_id
           WHERE vc.code_type = 'PART_NUMBER' AND vc.code = ANY(${parts})`
      : Promise.resolve([]),
    codes.length
      ? db<{ id: string; code: string; batch: string; status: string }[]>`
          SELECT i.id::text, c.code, b.code AS batch, i.status::text AS status FROM items i JOIN batches b ON b.id = i.batch_id
          CROSS JOIN LATERAL (VALUES (i.serial_number), (i.imei1), (i.imei2)) AS c(code)
           WHERE i.deleted_at IS NULL AND c.code = ANY(${codes})`
      : Promise.resolve([]),
    db<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'scan.expected_region'`,
  ]);
  const vmap = new Map(variants.map((v) => [v.code, { id: v.id, label: variantLabel(v.model, v) }]));
  const count = new Map<string, number>();
  for (const r of rows) for (const c of codesOf(r.extracted.fields ?? {})) count.set(c, (count.get(c) ?? 0) + 1);
  const expectedRegion = typeof region[0]?.value === "string" ? (region[0].value as string) : "LL/A";
  return rows.map((r) => {
    const f = r.extracted.fields ?? {};
    const pn = f.partNumber?.value;
    const variant = pn ? (vmap.get(pn) ?? null) : null;
    const mine = codesOf(f);
    const ex = existing.filter((e) => mine.includes(e.code));
    const review = reviewCapture(f, {
      variantLabel: pn ? (variant?.label ?? null) : undefined,
      existing: ex.map((e) => ({ code: e.code, label: `chuyến ${e.batch} (${e.status})` })),
      duplicateInInbox: mine.some((c) => (count.get(c) ?? 0) > 1),
      expectedRegion,
    });
    return {
      id: r.id,
      createdAt: r.created_at,
      source: r.source,
      fields: f,
      extras: r.extracted.extras ?? [],
      note: r.extracted.note ?? null,
      variant,
      ...review,
      existingItemIds: [...new Set(ex.map((e) => e.id))],
    };
  });
}

async function pending(tx: TransactionSql, ids: readonly string[]) {
  if (!ids.length) throw new ScanInboxError("INVALID_INPUT", "Chọn ít nhất một dòng", "ids");
  const rows = await tx<{ id: string; extracted: Extracted }[]>`
    SELECT id::text, extracted FROM scan_captures WHERE id = ANY(${ids as string[]}::uuid[]) AND status = 'PENDING_REVIEW' FOR UPDATE`;
  if (rows.length !== new Set(ids).size) throw new ScanInboxError("NOT_FOUND", "Có dòng không còn trong hộp chờ (đã xử lý ở nơi khác?) — tải lại trang");
  const order = new Map(ids.map((id, k) => [id, k]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** Sửa giá trị một dòng (nguồn của ô đổi thành "tay" nếu giá trị khác). Ô trống = xoá giá trị. */
export async function updateCapture(db: Db, id: string, values: Partial<Record<InboxField, string>>) {
  return db.begin(async (tx) => {
    const [row] = await pending(tx, [id]);
    const fields = { ...(row.extracted.fields ?? {}) };
    for (const [k, raw] of Object.entries(values) as [InboxField, string][]) {
      const v = raw.replace(/\s+/g, "").toUpperCase().slice(0, 40);
      if (!v) delete fields[k];
      else if (fields[k]?.value !== v) fields[k] = { value: v, source: "MANUAL" as InboxSource };
    }
    await tx`UPDATE scan_captures SET extracted = ${tx.json({ ...row.extracted, fields } as never)} WHERE id = ${id}`;
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
             VALUES ('UPDATE', 'scan_capture', ${id}, ${tx.json(row.extracted.fields as never)}, ${tx.json(fields as never)})`;
  });
}

export async function discardCaptures(db: Db, ids: readonly string[]) {
  return db.begin(async (tx) => {
    await pending(tx, ids);
    await tx`UPDATE scan_captures SET status = 'DISCARDED', reviewed_at = now() WHERE id = ANY(${ids as string[]}::uuid[])`;
    await tx`INSERT INTO audit_logs (action, entity_type, after) VALUES ('DELETE', 'scan_capture', ${tx.json({ discarded: ids })})`;
    return ids.length;
  });
}

/**
 * Xác nhận vào đơn mua: mỗi dòng thành một máy mới (cấu hình theo Part No. đã gán, hoặc cấu hình chọn chung),
 * đơn giá chung. Kiểm tra toàn bộ trước — một dòng lỗi thì không tạo máy nào.
 */
export async function confirmIntoPurchaseOrder(
  db: Db,
  ids: readonly string[],
  opts: { purchaseOrderId: string; unitPrice: string; variantId?: string | null },
) {
  return db.begin(async (tx) => {
    const rows = await pending(tx, ids);
    const [po] = await tx`SELECT 1 FROM purchase_orders WHERE id = ${opts.purchaseOrderId} AND deleted_at IS NULL`;
    if (!po) throw new ScanInboxError("NOT_FOUND", "Không tìm thấy đơn mua", "purchaseOrderId");
    if (!opts.unitPrice.trim()) throw new ScanInboxError("INVALID_INPUT", "Nhập đơn giá (USD) cho các máy", "unitPrice");
    const parts = rows.flatMap((r) => (r.extracted.fields.partNumber?.value ? [r.extracted.fields.partNumber.value] : []));
    const vmap = new Map(
      (parts.length
        ? await tx<
            { code: string; id: string }[]
          >`SELECT code, variant_id::text AS id FROM variant_codes WHERE code_type = 'PART_NUMBER' AND code = ANY(${parts})`
        : []
      ).map((v) => [v.code, v.id]),
    );
    const errors: { id: string; message: string }[] = [];
    const gridRows: GridRow[] = rows.map((r) => {
      const f = r.extracted.fields;
      const variantId = (f.partNumber?.value && vmap.get(f.partNumber.value)) || opts.variantId || "";
      if (!variantId)
        errors.push({ id: r.id, message: `Chưa biết cấu hình (Part No. ${f.partNumber?.value ?? "trống"}) — chọn cấu hình chung hoặc gán mã ở Danh mục` });
      return {
        ...emptyRow(),
        variantId,
        unitPrice: opts.unitPrice,
        serial: f.serial?.value ?? "",
        imei1: f.imei1?.value ?? "",
        imei2: f.imei2?.value ?? "",
        partNumber: f.partNumber?.value ?? "",
        note: r.extracted.note ?? "",
      };
    });
    if (errors.length) throw new ScanInboxError("INVALID_INPUT", `${errors.length} dòng chưa có cấu hình`, "variantId", errors);
    const res = await appendItems(tx, opts.purchaseOrderId, gridRows);
    // ghép máy mới với dòng hộp chờ theo Serial / IMEI
    const made = await tx<{ id: string; serial_number: string | null; imei1: string | null; imei2: string | null }[]>`
      SELECT id::text, serial_number, imei1, imei2 FROM items WHERE id = ANY(${res.newIds}::uuid[])`;
    for (const r of rows) {
      const codes = codesOf(r.extracted.fields);
      const item = made.find((m) => codes.some((c) => c === m.serial_number || c === m.imei1 || c === m.imei2));
      if (!item) throw new ScanInboxError("INVALID_INPUT", "Không ghép được máy vừa tạo với dòng hộp chờ");
      await tx`UPDATE scan_captures SET status = 'CONFIRMED', item_id = ${item.id}, context_type = 'PURCHASE_ORDER', context_id = ${opts.purchaseOrderId}, reviewed_at = now()
               WHERE id = ${r.id}`;
    }
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after)
             VALUES ('UPDATE', 'purchase_order', ${opts.purchaseOrderId}, ${tx.json({ fromInbox: rows.length })})`;
    return { created: res.newIds.length, recalc: res.recalc };
  });
}

/** Xác nhận vào kiện (nhận hàng): máy đã có trong hệ thống được quét vào kiện; dòng không khớp được giữ lại kèm lý do. */
export async function confirmIntoShipment(db: Db, ids: readonly string[], shipmentId: string) {
  return db.begin(async (tx) => {
    const rows = await pending(tx, ids);
    const codes = [...new Set(rows.flatMap((r) => codesOf(r.extracted.fields)))];
    if (!codes.length) throw new ScanInboxError("INVALID_INPUT", "Các dòng đã chọn chưa có Serial / IMEI");
    const res = await assignItems(tx, shipmentId, codes);
    const itemOf = new Map<string, string>(res.added.map((a) => [a.code, a.id]));
    // máy đã nằm sẵn trong kiện này cũng coi như xong
    const inShip = await tx<{ item_id: string; serial_number: string | null; imei1: string | null; imei2: string | null }[]>`
      SELECT si.item_id::text, i.serial_number, i.imei1, i.imei2 FROM shipment_items si JOIN items i ON i.id = si.item_id WHERE si.shipment_id = ${shipmentId}`;
    for (const s of inShip) for (const c of [s.serial_number, s.imei1, s.imei2]) if (c && !itemOf.has(c)) itemOf.set(c, s.item_id);
    let confirmed = 0;
    for (const r of rows) {
      const item = codesOf(r.extracted.fields)
        .map((c) => itemOf.get(c))
        .find(Boolean);
      if (!item) continue;
      await tx`UPDATE scan_captures SET status = 'CONFIRMED', item_id = ${item}, context_type = 'SHIPMENT_RECEIVING', context_id = ${shipmentId}, reviewed_at = now()
               WHERE id = ${r.id}`;
      confirmed++;
    }
    return { confirmed, kept: rows.length - confirmed, rejected: res.rejected.filter((x) => !itemOf.has(x.code)) };
  });
}

export async function inboxCount(db: Db): Promise<number> {
  const [r] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM scan_captures WHERE status = 'PENDING_REVIEW'`;
  return r.n;
}

/** Đích xác nhận: đơn mua của chuyến chưa chốt, kiện chưa nhận. */
export async function inboxTargets(db: Db) {
  const [orders, shipments, variants] = await Promise.all([
    db<{ id: string; label: string }[]>`
      SELECT po.id::text, b.code || ' · ' || COALESCE(sp.name, '') || COALESCE(' · ' || po.order_number, '') AS label
        FROM purchase_orders po JOIN batches b ON b.id = po.batch_id AND b.deleted_at IS NULL LEFT JOIN suppliers sp ON sp.id = po.supplier_id
       WHERE po.deleted_at IS NULL AND b.status NOT IN ('COSTS_FINALIZED', 'CLOSED') ORDER BY po.ordered_at DESC LIMIT 100`,
    db<{ id: string; leg: string; code: string | null; carrier: string | null }[]>`
      SELECT s.id::text, s.leg_type::text AS leg, COALESCE(s.tracking_number, s.reference_code) AS code, c.name AS carrier
        FROM shipments s LEFT JOIN carriers c ON c.id = s.carrier_id
       WHERE s.status NOT IN ('ARRIVED', 'CANCELLED', 'LOST') ORDER BY s.created_at DESC LIMIT 100`,
    db<{ id: string; model: string; storage: string | null; color: string | null; chip: string | null; memory: string | null; connectivity: string | null }[]>`
      SELECT v.id::text, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity
        FROM product_variants v JOIN product_models m ON m.id = v.model_id WHERE v.is_active ORDER BY m.name, v.storage, v.color`,
  ]);
  const LEG: Record<string, string> = { US_DOMESTIC: "Nội địa Mỹ", US_TO_VN: "Mỹ → VN", HN_TO_SG: "HN → SG", SG_LOCAL: "Nội thành SG", OTHER: "Khác" };
  return {
    orders,
    shipments: shipments.map((s) => ({ id: s.id, label: [LEG[s.leg] ?? s.leg, s.code ?? "chưa có mã", s.carrier].filter(Boolean).join(" · ") })),
    variants: variants.map((v) => ({ id: v.id, label: variantLabel(v.model, v) })),
  };
}
