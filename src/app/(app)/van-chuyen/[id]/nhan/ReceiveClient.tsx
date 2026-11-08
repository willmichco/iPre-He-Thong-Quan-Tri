"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { checkReceipt, scannable, type ExpectedItem } from "@/domain/receiving";
import type { DeviceRecord } from "@/domain/scan-session";
import { TIME_ZONES } from "@/domain/tracking";
import { ActionForm, Checkbox, Input, Select, Submit } from "../../../_components/form";
import { Glyph } from "../../../_components/Glyph";
import { ScannerSkeleton } from "../../../quet-ma/ScannerSkeleton";
import { receiveScanAction } from "../../actions";

// Bộ quét dùng camera, WebAssembly và localStorage → chỉ chạy trên trình duyệt.
const Scanner = dynamic(() => import("@/features/scanner/Scanner").then((m) => m.Scanner), {
  ssr: false,
  loading: () => <ScannerSkeleton embedded />,
});
const WASM = { url: "/wasm/zxing_reader.wasm" };

const sessionKey = (shipmentId: string) => `ipre.nhan-kien.${shipmentId}`;

/** Kiện đã nhận → xoá phiên quét tạm của kiện trên thiết bị. */
export function ClearReceiveSession({ shipmentId }: { shipmentId: string }) {
  useEffect(() => {
    try {
      localStorage.removeItem(sessionKey(shipmentId));
    } catch {
      /* chỉ là dọn dẹp */
    }
  }, [shipmentId]);
  return null;
}

/** Mã định danh (Serial / IMEI) trong phiên quét — Part No., UPC không dùng để đối chiếu máy. */
function codesOf(records: readonly DeviceRecord[]): string[] {
  return records.flatMap((r) => [r.fields.serial?.value, r.fields.imei1?.value, r.fields.imei2?.value].filter((v): v is string => Boolean(v)));
}

export function ReceiveClient({
  shipmentId,
  items,
  defaultAt,
  arriveLabel,
}: {
  shipmentId: string;
  items: (ExpectedItem & { batchCode: string })[];
  defaultAt: string;
  arriveLabel: string;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const onRecords = useCallback((r: DeviceRecord[]) => setCodes(codesOf(r)), []);
  const chk = useMemo(() => checkReceipt(items, codes), [items, codes]);
  const done = chk.matched.length;
  const total = items.length;
  const noCode = items.filter((i) => !scannable(i)).length;

  const complete = total > 0 && done === total;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="card sticky top-2 z-10 bg-[var(--surface-solid)] p-3.5 md:p-4" role="status" aria-live="polite" data-testid="receive-progress">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className={`flex items-center gap-2 text-lg font-semibold ${complete ? "text-[var(--ok)]" : ""}`}>
            {complete && <Glyph name="checkCircle" size={20} />}
            <span>
              Đã quét {done}/{total} máy{complete ? " · đủ" : ` · còn thiếu ${total - done}`}
            </span>
          </p>
          {chk.outside.length > 0 && (
            <span className="badge" data-tone="warn">
              {chk.outside.length} mã ngoài kiện
            </span>
          )}
        </div>
        <div className="progress mt-2.5" data-tone={complete ? "ok" : undefined} aria-hidden>
          <span style={{ transform: `scaleX(${total ? done / total : 0})` }} />
        </div>
      </div>

      {/* khối bọc thường (block): gốc bộ quét dùng container query + margin auto → làm con trực tiếp của cột flex sẽ co về 0 */}
      <div>
        <Scanner wasm={WASM} ocrBase="/ocr" storageKey={sessionKey(shipmentId)} onRecordsChange={onRecords} embedded />
      </div>

      <section className="card p-4 md:p-5" aria-labelledby="doi-chieu">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="doi-chieu" className="font-semibold">
            Đối chiếu với kiện
          </h2>
          <span className="flex flex-wrap gap-1.5">
            <span className="badge" data-tone="ok">
              {done} khớp
            </span>
            {chk.missing.length > 0 && (
              <span className="badge" data-tone="muted">
                {chk.missing.length} còn thiếu
              </span>
            )}
          </span>
        </div>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm" aria-label="Danh sách đối chiếu">
          {chk.outside.map((c) => (
            <li key={c} className="flex items-center gap-2.5 rounded-2xl bg-[var(--warn-bg)] px-3 py-2.5" data-state="outside">
              <Glyph name="warn" size={18} className="shrink-0 text-[var(--warn)]" />
              <span className="min-w-0">
                Không có trong kiện: <span className="font-mono text-[13px] font-medium">{c}</span>
              </span>
            </li>
          ))}
          {chk.matched.map((i) => (
            <li key={i.id} className="flex items-center gap-2.5 rounded-2xl bg-[var(--ok-bg)] px-3 py-2.5" data-state="ok">
              <Glyph name="checkCircle" size={18} className="shrink-0 text-[var(--ok)]" />
              <span className="min-w-0">
                <span className="block font-medium">{i.label}</span>
                <span className="font-mono text-xs text-muted">{i.serial ?? i.imei1}</span>
              </span>
            </li>
          ))}
          {chk.missing.map((i) => (
            <li key={i.id} className="flex items-center gap-2.5 rounded-2xl bg-[var(--fill)] px-3 py-2.5" data-state="missing">
              <Glyph name="missing" size={18} className="shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block">
                  <span className="text-muted">Còn thiếu: </span>
                  {i.label}
                </span>
                <span className="font-mono text-xs text-muted">{i.serial ?? i.imei1 ?? "chưa có Serial / IMEI"}</span>
                <span className="text-xs text-muted"> · {i.batchCode}</span>
              </span>
            </li>
          ))}
        </ul>
        {noCode > 0 && (
          <div className="callout mt-3" data-tone="warn">
            <Glyph name="warn" size={16} />
            <p>
              {noCode} máy trong kiện chưa có Serial / IMEI nên không đối chiếu bằng quét được — bổ sung mã ở trang máy trước, hoặc nhận kèm ghi sự cố.
            </p>
          </div>
        )}

        <ActionForm action={receiveScanAction} label="Xác nhận nhận kiện" className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          <input type="hidden" name="id" value={shipmentId} />
          <input type="hidden" name="codes" value={codes.join("\n")} />
          <div className="field-row">
            <Input label={`Ngày giờ nhận — ${arriveLabel}`} name="at" type="datetime-local" defaultValue={defaultAt} className="w-56" />
            <Select label="Theo giờ" name="tz" options={TIME_ZONES} defaultValue="Asia/Ho_Chi_Minh" className="w-60" />
          </div>
          {chk.missing.length > 0 && (
            <Checkbox
              label={`Nhận phần đã quét (${done} máy), ghi sự cố thiếu ${chk.missing.length} máy — máy thiếu giữ trạng thái đang vận chuyển`}
              name="acceptShortage"
            />
          )}
          <div>
            <Submit>{chk.missing.length ? `Xác nhận nhận ${done}/${total} máy` : `Xác nhận nhận đủ ${total} máy`}</Submit>
          </div>
        </ActionForm>
      </section>
    </div>
  );
}
