/**
 * Chứng từ đính kèm: tải lên (kiểm tra định dạng thật, khử trùng theo SHA-256), danh sách, xoá mềm,
 * hồ sơ nguồn gốc của một máy (gom chứng từ của máy, đơn mua, chuyến, các kiện, đơn bán) và
 * danh sách máy còn đang kinh doanh mà thiếu chứng từ. Mọi thay đổi ghi `audit_logs`.
 */
import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import {
  checkUpload,
  dossierGaps,
  ENTITY_LABEL,
  KIND_FOR,
  MAX_FILES_PER_UPLOAD,
  MAX_TOTAL_BYTES,
  storageKey,
  type DocKind,
  type EntityType,
} from "@/domain/attachments";
import { fileStore } from "./storage";

type Db = Sql | TransactionSql;

export class AttachmentError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_INPUT",
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface Attachment {
  id: string;
  entityType: EntityType;
  entityId: string;
  kind: DocKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

type Raw = {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  kind: DocKind;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  uploaded_at: string;
};
const map = (r: Raw): Attachment => ({
  id: r.id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  kind: r.kind,
  fileName: r.file_name,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  uploadedAt: r.uploaded_at,
});
const COLS = (db: Db) =>
  db`a.id::text, a.entity_type, a.entity_id::text, a.kind, a.file_name, a.mime_type, a.size_bytes::text,
     to_char(a.uploaded_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS uploaded_at`;

/** Đối tượng có tồn tại không (và chưa xoá). */
async function entityExists(db: Db, type: EntityType, id: string): Promise<boolean> {
  const q =
    type === "BATCH"
      ? db`SELECT 1 FROM batches WHERE id = ${id} AND deleted_at IS NULL`
      : type === "PURCHASE_ORDER"
        ? db`SELECT 1 FROM purchase_orders WHERE id = ${id} AND deleted_at IS NULL`
        : type === "ITEM"
          ? db`SELECT 1 FROM items WHERE id = ${id} AND deleted_at IS NULL`
          : type === "SHIPMENT"
            ? db`SELECT 1 FROM shipments WHERE id = ${id}`
            : type === "COST"
              ? db`SELECT 1 FROM costs WHERE id = ${id} AND deleted_at IS NULL`
              : type === "SALE"
                ? db`SELECT 1 FROM sales WHERE id = ${id}`
                : db`SELECT 1 FROM cash_transactions WHERE id = ${id} AND deleted_at IS NULL`;
  return (await q).length > 0;
}

export interface UploadResult {
  added: number;
  duplicates: string[];
}

/**
 * Lưu các tệp vào kho rồi ghi dòng `attachments`. Kiểm tra TẤT CẢ tệp trước khi lưu tệp nào (một tệp sai → không lưu gì).
 * Cùng nội dung đã gắn vào cùng đối tượng → bỏ qua, báo trùng.
 */
export async function uploadAttachments(
  db: Db,
  target: { entityType: EntityType; entityId: string; kind: DocKind },
  files: readonly { name: string; bytes: Uint8Array }[],
  now = new Date(),
): Promise<UploadResult> {
  if (!KIND_FOR[target.entityType]) throw new AttachmentError("INVALID_INPUT", "Đối tượng không hợp lệ");
  if (!files.length) throw new AttachmentError("INVALID_INPUT", "Chọn tệp chứng từ (ảnh hoặc PDF)", "files");
  if (files.length > MAX_FILES_PER_UPLOAD) throw new AttachmentError("INVALID_INPUT", `Tối đa ${MAX_FILES_PER_UPLOAD} tệp mỗi lần`, "files");
  if (files.reduce((s, f) => s + f.bytes.length, 0) > MAX_TOTAL_BYTES)
    throw new AttachmentError("INVALID_INPUT", `Tổng dung lượng một lần tải tối đa ${MAX_TOTAL_BYTES / 1024 / 1024} MB — chia thành nhiều lần`, "files");
  const checked = files.map((f) => {
    const c = checkUpload(f.name, f.bytes);
    if (!c.ok) throw new AttachmentError("INVALID_INPUT", c.error, "files");
    const sha = createHash("sha256").update(f.bytes).digest("hex");
    return { ...c, bytes: f.bytes, sha, key: storageKey(sha, c.ext, now) };
  });
  return db.begin(async (tx) => {
    if (!(await entityExists(tx, target.entityType, target.entityId)))
      throw new AttachmentError("NOT_FOUND", `Không tìm thấy ${ENTITY_LABEL[target.entityType].toLowerCase()} để gắn chứng từ`);
    const store = fileStore();
    const duplicates: string[] = [];
    let added = 0;
    for (const f of checked) {
      const [dup] = await tx`
        SELECT 1 FROM attachments WHERE entity_type = ${target.entityType} AND entity_id = ${target.entityId} AND sha256 = ${f.sha} AND deleted_at IS NULL`;
      if (dup) {
        duplicates.push(f.name);
        continue;
      }
      // cùng nội dung đã lưu (ở đối tượng khác) → dùng lại tệp cũ, không lưu lại
      const [same] = await tx<{ file_key: string }[]>`SELECT file_key FROM attachments WHERE sha256 = ${f.sha} LIMIT 1`;
      const key = same?.file_key ?? f.key;
      if (!(await store.has(key))) await store.put(key, f.bytes);
      // clock_timestamp(): mỗi tệp một thời điểm thật (now() là lúc bắt đầu transaction → các tệp cùng lượt trùng giờ, thứ tự ngẫu nhiên)
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO attachments (entity_type, entity_id, kind, file_key, file_name, mime_type, size_bytes, sha256, uploaded_at)
        VALUES (${target.entityType}, ${target.entityId}, ${target.kind}, ${key}, ${f.name}, ${f.mime}, ${f.bytes.length}, ${f.sha}, clock_timestamp())
        RETURNING id::text`;
      await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after)
               VALUES ('CREATE', 'attachment', ${row.id}, ${tx.json({ ...target, fileName: f.name, sha256: f.sha })})`;
      added++;
    }
    return { added, duplicates };
  });
}

export async function listAttachments(db: Db, entityType: EntityType, ids: readonly string[]): Promise<Attachment[]> {
  if (!ids.length) return [];
  const rows = await db<Raw[]>`
    SELECT ${COLS(db)} FROM attachments a
     WHERE a.entity_type = ${entityType} AND a.entity_id = ANY(${ids as string[]}::uuid[]) AND a.deleted_at IS NULL
     ORDER BY a.uploaded_at, a.id`;
  return rows.map(map);
}

export async function getAttachment(db: Db, id: string): Promise<(Attachment & { fileKey: string }) | null> {
  const [r] = await db<(Raw & { file_key: string })[]>`SELECT ${COLS(db)}, a.file_key FROM attachments a WHERE a.id = ${id} AND a.deleted_at IS NULL`;
  return r ? { ...map(r), fileKey: r.file_key } : null;
}

/** Xoá mềm (tệp vẫn giữ trong kho — chứng từ có thể cần xuất trình lại; nhật ký ghi lại ai xoá lúc nào). */
export async function deleteAttachment(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [r] = await tx<{ id: string }[]>`UPDATE attachments SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL RETURNING id::text`;
    if (!r) throw new AttachmentError("NOT_FOUND", "Không tìm thấy chứng từ");
    await tx`INSERT INTO audit_logs (action, entity_type, entity_id) VALUES ('DELETE', 'attachment', ${id})`;
  });
}

// ---- Hồ sơ nguồn gốc ------------------------------------------------------------------------------------

export interface DossierSection {
  entityType: EntityType;
  entityId: string;
  title: string;
  href: string;
  docs: Attachment[];
}

/** Toàn bộ chứng từ liên quan một máy, theo thứ tự hành trình: đơn mua → chuyến → các kiện → máy → đơn bán. */
export async function itemDossier(db: Db, itemId: string) {
  const [it] = await db<{ po: string; po_no: string | null; supplier: string | null; batch: string; batch_code: string }[]>`
    SELECT i.purchase_order_id::text AS po, po.order_number AS po_no, sp.name AS supplier, i.batch_id::text AS batch, b.code AS batch_code
      FROM items i JOIN purchase_orders po ON po.id = i.purchase_order_id JOIN batches b ON b.id = i.batch_id
      LEFT JOIN suppliers sp ON sp.id = po.supplier_id
     WHERE i.id = ${itemId} AND i.deleted_at IS NULL`;
  if (!it) return null;
  const [ships, sales] = await Promise.all([
    db<{ id: string; leg: string; tracking: string | null; carrier: string | null; shipped: boolean }[]>`
      SELECT s.id::text, s.leg_type::text AS leg, s.tracking_number AS tracking, c.name AS carrier, s.shipped_at IS NOT NULL AS shipped
        FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id LEFT JOIN carriers c ON c.id = s.carrier_id
       WHERE si.item_id = ${itemId} ORDER BY array_position(ARRAY['US_DOMESTIC','US_TO_VN','HN_TO_SG','SG_LOCAL','OTHER']::leg_type[], s.leg_type)`,
    db<{ id: string; code: string }[]>`
      SELECT DISTINCT s.id::text, s.code FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.item_id = ${itemId} ORDER BY s.code`,
  ]);
  const LEG = { US_DOMESTIC: "Nội địa Mỹ", US_TO_VN: "Mỹ → VN", HN_TO_SG: "HN → SG", SG_LOCAL: "Nội thành SG", OTHER: "Khác" } as Record<string, string>;
  const sections: Omit<DossierSection, "docs">[] = [
    {
      entityType: "PURCHASE_ORDER",
      entityId: it.po,
      title: `Đơn mua ${it.po_no ?? ""}${it.supplier ? ` · ${it.supplier}` : ""}`.replace("  ", " "),
      href: `/chuyen-hang/${it.batch}`,
    },
    { entityType: "BATCH", entityId: it.batch, title: `Chuyến ${it.batch_code}`, href: `/chuyen-hang/${it.batch}` },
    ...ships.map((s) => ({
      entityType: "SHIPMENT" as const,
      entityId: s.id,
      title: `Kiện ${LEG[s.leg] ?? s.leg}${s.tracking ? ` · ${s.tracking}` : ""}${s.carrier ? ` · ${s.carrier}` : ""}`,
      href: `/van-chuyen/${s.id}`,
    })),
    { entityType: "ITEM", entityId: itemId, title: "Máy (ảnh hộp, tem, tình trạng)", href: `/kho/${itemId}` },
    ...sales.map((s) => ({ entityType: "SALE" as const, entityId: s.id, title: `Đơn bán ${s.code}`, href: `/ban-hang/${s.id}` })),
  ];
  const docs = await db<Raw[]>`
    SELECT ${COLS(db)} FROM attachments a
      JOIN unnest(${sections.map((s) => s.entityType)}::text[], ${sections.map((s) => s.entityId)}::uuid[]) AS x(t, id)
        ON x.t = a.entity_type AND x.id = a.entity_id
     WHERE a.deleted_at IS NULL
     ORDER BY a.uploaded_at, a.id`;
  const full: DossierSection[] = sections.map((s) => ({
    ...s,
    docs: docs.filter((d) => d.entity_type === s.entityType && d.entity_id === s.entityId).map(map),
  }));
  const importDoc = (s: DossierSection) =>
    (s.entityType === "SHIPMENT" || s.entityType === "BATCH") && s.docs.some((d) => d.kind === "AWB" || d.kind === "CUSTOMS");
  const gaps = dossierGaps({
    hasPurchaseDoc: full[0].docs.some((d) => d.kind === "INVOICE" || d.kind === "RECEIPT"),
    crossedBorder: ships.some((s) => s.leg === "US_TO_VN" && s.shipped),
    hasImportDoc: full.some(importDoc),
  });
  return { sections: full, gaps };
}

export interface MissingDocRow {
  itemId: string;
  label: string;
  serial: string | null;
  status: string;
  batchId: string;
  batchCode: string;
  gaps: ("PURCHASE" | "IMPORT")[];
}

/** Máy đang trong tay (chưa bán / chưa trả) thiếu chứng từ nguồn gốc — đi đường hoặc tồn kho đều có thể bị kiểm tra. */
export async function missingDossiers(db: Db): Promise<MissingDocRow[]> {
  const rows = await db<
    {
      id: string;
      model: string;
      storage: string | null;
      color: string | null;
      serial: string | null;
      status: string;
      batch: string;
      code: string;
      has_po: boolean;
      crossed: boolean;
      has_imp: boolean;
    }[]
  >`
    WITH docs AS (
      SELECT entity_type, entity_id, kind FROM attachments WHERE deleted_at IS NULL
    )
    SELECT i.id::text, m.name AS model, v.storage, v.color, i.serial_number AS serial, i.status::text AS status, i.batch_id::text AS batch, b.code,
           EXISTS (SELECT 1 FROM docs d WHERE d.entity_type = 'PURCHASE_ORDER' AND d.entity_id = i.purchase_order_id AND d.kind IN ('INVOICE', 'RECEIPT')) AS has_po,
           EXISTS (SELECT 1 FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                    WHERE si.item_id = i.id AND s.leg_type = 'US_TO_VN' AND s.shipped_at IS NOT NULL) AS crossed,
           (EXISTS (SELECT 1 FROM shipment_items si JOIN docs d ON d.entity_type = 'SHIPMENT' AND d.entity_id = si.shipment_id AND d.kind IN ('AWB', 'CUSTOMS')
                     WHERE si.item_id = i.id)
            OR EXISTS (SELECT 1 FROM docs d WHERE d.entity_type = 'BATCH' AND d.entity_id = i.batch_id AND d.kind IN ('AWB', 'CUSTOMS'))) AS has_imp
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id JOIN batches b ON b.id = i.batch_id
     WHERE i.deleted_at IS NULL AND b.deleted_at IS NULL
       AND i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT', 'AT_HN', 'DOMESTIC_IN_TRANSIT', 'IN_STOCK', 'RESERVED', 'WARRANTY')
     ORDER BY b.code, m.name, i.serial_number`;
  return rows.flatMap((r) => {
    const gaps = dossierGaps({ hasPurchaseDoc: r.has_po, crossedBorder: r.crossed, hasImportDoc: r.has_imp });
    return gaps.length
      ? [
          {
            itemId: r.id,
            label: [r.model, r.storage, r.color].filter(Boolean).join(" · "),
            serial: r.serial,
            status: r.status,
            batchId: r.batch,
            batchCode: r.code,
            gaps,
          },
        ]
      : [];
  });
}
