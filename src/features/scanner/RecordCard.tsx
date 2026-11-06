import { memo, useState, type ReactNode } from "react";
import { FIELD_LABELS, setField, type DeviceRecord, type FieldKey, type FieldSource, type validateRecord } from "@/domain/scan-session";
import { Icon } from "./icons";

type Issue = ReturnType<typeof validateRecord>[number];

const SOURCE_BADGE: Record<FieldSource, { label: string; cls: string }> = {
  BARCODE: { label: "▌▌▌ Mã vạch", cls: "sc-badge-ok" },
  HW_SCANNER: { label: "▌▌▌ Máy quét", cls: "sc-badge-ok" },
  OCR: { label: "Aa Đọc chữ", cls: "sc-badge-warn" },
  PASTE: { label: "📋 Dán", cls: "sc-badge-info" },
  MANUAL: { label: "✍ Tay", cls: "sc-badge-info" },
};

const ORIGIN_LABEL: Record<DeviceRecord["origin"], string> = {
  CAMERA: "Camera",
  PHOTO: "Ảnh",
  HW_SCANNER: "Máy quét",
  PASTE: "Dán",
  MANUAL: "Nhập tay",
};

/** Nhãn hiển thị gọn (đủ chỗ cho 2 cột trên điện thoại); nhãn đầy đủ nằm ở title. */
const SHORT_LABEL: Partial<Record<FieldKey, string>> = { partNumber: "Part No." };

/**
 * Thứ tự hiển thị: Serial | Part No. chung một hàng, IMEI rộng hết hàng (15 số) — thứ tự DOM trùng thứ tự
 * nhìn thấy nên phím Tab đi đúng hàng.
 */
const DISPLAY_ORDER: FieldKey[] = ["serial", "partNumber", "imei1", "imei2", "upc", "eid"];

export interface RecordCardProps {
  record: DeviceRecord;
  index: number;
  issues: readonly Issue[];
  current: boolean;
  thumb?: string;
  onUpdate: (id: string, fn: (r: DeviceRecord) => DeviceRecord) => void;
  onRemove: (id: string) => void;
  renderPartNumberInfo?: (partNumber: string) => ReactNode;
}

function sameIssues(a: readonly Issue[], b: readonly Issue[]) {
  return a.length === b.length && a.every((x, i) => x.message === b[i].message && x.field === b[i].field && x.severity === b[i].severity);
}

/**
 * Thẻ một máy. Được ghi nhớ (memo): thêm / sửa một máy chỉ vẽ lại đúng thẻ đó — phiên dài vài chục máy vẫn mượt.
 * Bản ghi không đổi thì giữ nguyên đối tượng (xem scan-session), nên so sánh theo tham chiếu là đủ.
 */
export const RecordCard = memo(
  function RecordCard({ record: r, index, issues, current, thumb, onUpdate, onRemove, renderPartNumberInfo }: RecordCardProps) {
    const keys = DISPLAY_ORDER.filter((k) => k !== "eid" || r.fields.eid);
    const general = issues.filter((i) => !i.field);
    return (
      <article className={`sc-card ${current ? "is-current" : ""}`}>
        <header className="sc-card-head">
          {thumb ? (
            // ảnh thu nhỏ là data URL tạo trên máy — next/image không áp dụng; component còn dùng ngoài Next
            // eslint-disable-next-line @next/next/no-img-element
            <img className="sc-thumb" src={thumb} alt="" />
          ) : (
            <span className="sc-card-num" aria-hidden>
              {index}
            </span>
          )}
          <strong className="sc-card-title">Máy #{index}</strong>
          <span className="sc-origin" title={r.photoName}>
            {ORIGIN_LABEL[r.origin]}
            {r.photoName ? ` · ${r.photoName}` : ""}
          </span>
          {current && (
            <span className="sc-badge sc-badge-live">
              <span className="sc-live-dot" aria-hidden />
              đang quét
            </span>
          )}
          <button type="button" className="sc-icon-btn" aria-label={`Xoá máy #${index}`} title="Xoá máy này" onClick={() => onRemove(r.id)}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sc-fields">
          {keys.map((k) => (
            <FieldRow
              key={`${k}:${r.fields[k]?.value ?? ""}`}
              fieldKey={k}
              record={r}
              wide={k === "imei1" || k === "imei2" || (k === "upc" && !r.fields.eid)}
              issues={issues.filter((i) => i.field === k)}
              onChange={(v) => onUpdate(r.id, (rec) => setField(rec, k, v))}
            />
          ))}
          <label className="sc-field is-wide">
            <span className="sc-label">Ghi chú</span>
            <input
              className="sc-input sc-input-note"
              value={r.note ?? ""}
              placeholder="Tình trạng, pin, ngoại hình…"
              onChange={(e) => {
                const note = e.target.value;
                onUpdate(r.id, (rec) => ({ ...rec, note }));
              }}
            />
          </label>
        </div>
        {general.map((i) => (
          <p key={i.message} className={`sc-issue has-icon sc-issue-${i.severity}`}>
            <Icon name={i.severity === "error" ? "warn" : "info"} size={15} />
            {i.message}
          </p>
        ))}
        {renderPartNumberInfo && r.fields.partNumber?.value && renderPartNumberInfo(r.fields.partNumber.value)}
        {r.extras.length > 0 && <p className="sc-extras">Mã khác đọc được: {r.extras.join(" · ")}</p>}
      </article>
    );
  },
  (a, b) =>
    a.record === b.record &&
    a.index === b.index &&
    a.current === b.current &&
    a.thumb === b.thumb &&
    a.onUpdate === b.onUpdate &&
    a.onRemove === b.onRemove &&
    a.renderPartNumberInfo === b.renderPartNumberInfo &&
    sameIssues(a.issues, b.issues),
);

function FieldRow({
  fieldKey,
  record,
  wide,
  issues,
  onChange,
}: {
  fieldKey: FieldKey;
  record: DeviceRecord;
  wide: boolean;
  issues: readonly Issue[];
  onChange: (v: string) => void;
}) {
  const f = record.fields[fieldKey];
  // key của FieldRow gồm cả giá trị → khi giá trị đổi từ bên ngoài, ô được tạo lại với nháp mới
  const [draft, setDraft] = useState(f?.value ?? "");
  const isImei = fieldKey === "imei1" || fieldKey === "imei2";
  const hasError = issues.some((i) => i.severity === "error");
  return (
    <label className={`sc-field ${wide ? "is-wide" : ""}`} title={FIELD_LABELS[fieldKey]}>
      <span className="sc-label">
        {SHORT_LABEL[fieldKey] ?? FIELD_LABELS[fieldKey]}
        {f && <span className={`sc-badge ${SOURCE_BADGE[f.source].cls}`}>{SOURCE_BADGE[f.source].label}</span>}
      </span>
      <input
        className={`sc-input ${hasError ? "has-error" : issues.length ? "has-warning" : ""} ${f ? "has-value" : ""}`}
        value={draft}
        inputMode={isImei ? "numeric" : "text"}
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={hasError || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (f?.value ?? "") && onChange(draft)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {issues.map((i) => (
        <span key={i.message} className={`sc-issue sc-issue-${i.severity}`}>
          {i.message}
        </span>
      ))}
    </label>
  );
}
