"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { checkReceipt, scannable, type ExpectedItem } from "@/domain/receiving";
import type { DeviceRecord } from "@/domain/scan-session";
import { ActionForm, Checkbox, Input, Submit } from "../../../_components/form";
import { receiveScanAction } from "../../actions";

// Bộ quét dùng camera, WebAssembly và localStorage → chỉ chạy trên trình duyệt.
const Scanner = dynamic(() => import("@/features/scanner/Scanner").then((m) => m.Scanner), {
  ssr: false,
  loading: () => <p className="p-6 text-muted">Đang tải bộ quét…</p>,
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

  return (
    <div className="mt-4 flex flex-col gap-4">
      <p
        className={`card sticky top-2 z-10 p-3 text-lg font-semibold ${done === total ? "text-[var(--ok)]" : ""}`}
        role="status"
        aria-live="polite"
        data-testid="receive-progress"
      >
        Đã quét {done}/{total} máy{done === total ? " ✓ đủ" : ` · còn thiếu ${total - done}`}
        {chk.outside.length > 0 && <span className="ml-2 text-sm text-[var(--warn)]">· ⚠ {chk.outside.length} mã ngoài kiện</span>}
      </p>

      <div className="card overflow-hidden">
        <Scanner wasm={WASM} ocrBase="/ocr" storageKey={sessionKey(shipmentId)} onRecordsChange={onRecords} />
      </div>

      <section className="card p-4" aria-label="Đối chiếu">
        <ul className="flex flex-col gap-1 text-sm" aria-label="Danh sách đối chiếu">
          {chk.outside.map((c) => (
            <li key={c} className="text-[var(--warn)]" data-state="outside">
              ⚠ Không có trong kiện: <span className="font-mono">{c}</span>
            </li>
          ))}
          {chk.matched.map((i) => (
            <li key={i.id} className="text-[var(--ok)]" data-state="ok">
              ✓ {i.label} <span className="font-mono text-xs text-muted">{i.serial ?? i.imei1}</span>
            </li>
          ))}
          {chk.missing.map((i) => (
            <li key={i.id} className="text-muted" data-state="missing">
              ○ Còn thiếu: {i.label} <span className="font-mono text-xs">{i.serial ?? i.imei1 ?? "chưa có Serial / IMEI"}</span>{" "}
              <span className="text-xs">· {i.batchCode}</span>
            </li>
          ))}
        </ul>
        {noCode > 0 && (
          <p className="mt-2 text-xs text-[var(--warn)]">
            {noCode} máy trong kiện chưa có Serial / IMEI nên không đối chiếu bằng quét được — bổ sung mã ở trang máy trước, hoặc nhận kèm ghi sự cố.
          </p>
        )}

        <ActionForm action={receiveScanAction} label="Xác nhận nhận kiện" className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="id" value={shipmentId} />
          <input type="hidden" name="codes" value={codes.join("\n")} />
          <div className="field-row">
            <Input label={`Ngày giờ nhận — ${arriveLabel}`} name="at" type="datetime-local" defaultValue={defaultAt} className="w-56" />
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
