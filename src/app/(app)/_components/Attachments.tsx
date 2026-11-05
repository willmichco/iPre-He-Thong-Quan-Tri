/**
 * Khối chứng từ của một đối tượng (đơn mua, kiện, chuyến, máy, đơn bán…): danh sách tệp + tải lên.
 * Trên điện thoại, ô chọn tệp mở được camera để chụp hoá đơn / vận đơn ngay.
 */
import { DOC_KIND_LABEL, formatBytes, KIND_FOR, type EntityType } from "@/domain/attachments";
import type { Attachment } from "@/server/attachments/service";
import { deleteAttachmentAction, uploadAttachmentAction } from "./attachment-actions";
import { ActionForm, Input, Select, Submit } from "./form";

export function Attachments({
  entityType,
  entityId,
  docs,
  title = "Chứng từ",
  hint,
}: {
  entityType: EntityType;
  entityId: string;
  docs: readonly Attachment[];
  title?: string;
  hint?: string;
}) {
  const kinds = KIND_FOR[entityType].map((k) => [k, DOC_KIND_LABEL[k]] as const);
  return (
    <div className="flex flex-col gap-2" data-testid={`attachments-${entityType}`} data-entity={entityId}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">
          {title} <span className="font-normal text-muted">({docs.length})</span>
        </h3>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {docs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label={`${title} đã lưu`}>
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span aria-hidden>{d.mimeType === "application/pdf" ? "📄" : "🖼"}</span>
              <span className="chip">{DOC_KIND_LABEL[d.kind]}</span>
              <a href={`/chung-tu/${d.id}`} target="_blank" rel="noopener" className="min-w-0 truncate text-primary underline">
                {d.fileName}
              </a>
              <span className="text-xs text-muted">
                {formatBytes(d.sizeBytes)} · {d.uploadedAt.slice(8, 10)}/{d.uploadedAt.slice(5, 7)}/{d.uploadedAt.slice(0, 4)}
              </span>
              <a href={`/chung-tu/${d.id}?tai=1`} className="text-xs text-muted underline">
                Tải về
              </a>
              <ActionForm action={deleteAttachmentAction} confirm={`Xoá chứng từ ${d.fileName}?`} label={`Xoá ${d.fileName}`} className="inline">
                <input type="hidden" name="id" value={d.id} />
                <button type="submit" className="text-xs text-danger underline">
                  Xoá
                </button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-muted">+ Thêm chứng từ (ảnh / PDF)</summary>
        <ActionForm action={uploadAttachmentAction} resetOnSuccess label={`Tải ${title.toLowerCase()}`} className="field-row mt-2">
          <input type="hidden" name="entityType" value={entityType} />
          <input type="hidden" name="entityId" value={entityId} />
          <Select label="Loại" name="kind" options={kinds} />
          <Input label="Tệp (tối đa 10 tệp, 15 MB/tệp)" name="files" type="file" multiple accept="image/*,application/pdf" className="grow min-w-56" />
          <Submit>Tải lên</Submit>
        </ActionForm>
      </details>
    </div>
  );
}
