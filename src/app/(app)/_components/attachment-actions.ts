"use server";

import { DOC_KINDS, ENTITY_TYPES, type DocKind, type EntityType } from "@/domain/attachments";
import { optionalId, runFormAction } from "@/server/actions/run";
import { AttachmentError, deleteAttachment, uploadAttachments } from "@/server/attachments/service";
import type { FormState } from "./form-state";

export async function uploadAttachmentAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "chung-tu", async (db) => {
    const entityType = String(fd.get("entityType") ?? "") as EntityType;
    const kind = String(fd.get("kind") ?? "") as DocKind;
    const entityId = optionalId(fd, "entityId");
    if (!ENTITY_TYPES.includes(entityType) || !entityId) throw new AttachmentError("INVALID_INPUT", "Đối tượng không hợp lệ");
    if (!DOC_KINDS.includes(kind)) throw new AttachmentError("INVALID_INPUT", "Chọn loại chứng từ", "kind");
    const files = fd.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && f.size > 0);
    const list = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const r = await uploadAttachments(db, { entityType, entityId, kind }, list);
    const dup = r.duplicates.length ? ` · bỏ qua ${r.duplicates.length} tệp đã có` : "";
    return r.added ? `Đã lưu ${r.added} chứng từ${dup}` : `Không có tệp mới${dup}`;
  });
}

export async function deleteAttachmentAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "chung-tu", async (db) => {
    const id = optionalId(fd);
    if (!id) throw new AttachmentError("NOT_FOUND", "Thiếu mã chứng từ");
    await deleteAttachment(db, id);
    return "Đã xoá chứng từ";
  });
}
