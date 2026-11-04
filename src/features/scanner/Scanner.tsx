"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  applyExtraction,
  emptyRecord,
  findMatch,
  mergeRecord,
  mergeLiveFrame,
  mergeStream,
  recordsFromPhoto,
  setField,
  toCsv,
  toTsv,
  validateRecord,
  type DeviceRecord,
  type FieldKey,
  type FieldSource,
  type PositionedCode,
  type StreamState,
} from "@/domain/scan-session";
import { classifyCode, splitPastedText } from "@/domain/identifiers";
import { extractFromText, hasIdentity, hasStrongIdentity } from "@/domain/text-extract";
import { captureVideoFrame, decodePhoto, decodeVideoFrame, initDecoder, rasterizeImageUrl, type WasmSource } from "./decoder";
import { recognizeText } from "./ocr";
import "./scanner.css";

type Mode = "camera" | "photo" | "manual";

export interface ScannerProps {
  wasm: WasmSource;
  /** Thư mục chứa bộ đọc chữ Tesseract (vd: "/ocr"); null = không có đọc chữ. */
  ocrBase?: string | null;
  /** Khoá lưu phiên quét trên thiết bị (localStorage). */
  storageKey?: string;
  /** Mã thị trường mong đợi — cảnh báo khi khác (mặc định hàng Mỹ LL/A). */
  expectedRegion?: string;
  /** Cách đưa file CSV cho người dùng; mặc định tải xuống bằng trình duyệt. */
  saveFile?: (filename: string, content: string) => Promise<void>;
  /** false khi môi trường không cho mở camera trực tiếp (vd: trang xem thử) — vẫn chụp ảnh được. */
  liveCamera?: boolean;
  /** Ảnh nhãn hộp mẫu để thử nhanh khi chưa có hộp thật. */
  sampleLabelUrl?: string;
}

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

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function loadSession(key: string): StreamState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as StreamState;
      if (Array.isArray(parsed.records)) return parsed;
    }
  } catch {
    /* bộ nhớ trình duyệt không dùng được — bắt đầu phiên mới */
  }
  return { records: [], currentId: null };
}

function feedback() {
  try {
    navigator.vibrate?.(60);
  } catch {
    /* không hỗ trợ rung */
  }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1320;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
    osc.onended = () => ctx.close();
  } catch {
    /* không phát được âm thanh */
  }
}

async function defaultSaveFile(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Lấy ảnh và chữ từ sự kiện dán (ảnh chụp màn hình đã sao chép, hoặc mã dạng chữ). */
function readClipboard(e: ClipboardEvent | ReactClipboardEvent) {
  const dt = e.clipboardData;
  const images: File[] = [];
  if (dt) {
    for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/")) images.push(f);
    if (images.length === 0)
      for (const it of Array.from(dt.items ?? [])) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) images.push(f);
        }
      }
  }
  return { images, text: dt?.getData("text/plain") ?? "" };
}

export interface ImageResult {
  barcodes: number;
  usedOcr: boolean;
  added: number;
  updated: number;
}

export function Scanner({
  wasm,
  ocrBase = null,
  storageKey = "ipre.scan-session",
  expectedRegion = "LL/A",
  saveFile = defaultSaveFile,
  liveCamera = true,
  sampleLabelUrl,
}: ScannerProps) {
  // Component chỉ chạy phía trình duyệt (xem ScannerClient) nên đọc localStorage ngay được.
  const [session, setSession] = useState<StreamState>(() => loadSession(storageKey));
  const sessionRef = useRef<StreamState>(session);
  const [mode, setMode] = useState<Mode>(liveCamera ? "camera" : "photo");
  const [confirmClear, setConfirmClear] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [decoderState, setDecoderState] = useState<"loading" | "ready" | "error">("loading");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const ocrTried = useRef<Set<string>>(new Set());

  /** Mọi thay đổi phiên đi qua đây để ref (dùng trong vòng quét) luôn khớp state. */
  const update = useCallback(
    (fn: (s: StreamState) => StreamState) => {
      sessionRef.current = fn(sessionRef.current);
      setSession(sessionRef.current);
      try {
        localStorage.setItem(storageKey, JSON.stringify(sessionRef.current));
      } catch {
        /* bỏ qua: chỉ là tiện ích lưu tạm trên thiết bị */
      }
    },
    [storageKey],
  );

  useEffect(() => {
    initDecoder(wasm).then(
      () => setDecoderState("ready"),
      () => setDecoderState("error"),
    );
  }, [wasm]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000);
  }, []);

  /** Đọc chữ trên ảnh; trả về null khi không có bộ đọc chữ hoặc lỗi. */
  const ocr = useCallback(
    async (image: Blob) => {
      if (!ocrBase) return null;
      try {
        const text = await recognizeText(ocrBase, image, (p) => setBusy(`Đang tải bộ đọc chữ (lần đầu)… ${Math.round(p * 100)}%`));
        return extractFromText(text, { ocr: true });
      } catch {
        return null;
      }
    },
    [ocrBase],
  );

  /** Đưa một loạt mã (camera, máy quét, dán) vào phiên. Trả về số mã mới. */
  const ingestStream = useCallback(
    (codes: string[], source: FieldSource, origin: DeviceRecord["origin"]) => {
      const next = mergeStream(sessionRef.current, codes, source, origin, newId);
      if (next.added.length > 0) update(() => ({ records: next.records, currentId: next.currentId }));
      return next.added.length;
    },
    [update],
  );

  /** Đưa bản ghi mới vào phiên: trùng serial/IMEI với máy đã có thì chỉ bổ sung ô còn thiếu. */
  const addRecords = useCallback(
    (recs: DeviceRecord[], thumbnail?: string) => {
      let added = 0;
      let updated = 0;
      const addedIds: string[] = [];
      update((s) => {
        let records = [...s.records];
        for (const rec of recs) {
          const match = findMatch(records, rec);
          if (match) {
            const m = mergeRecord(match, rec);
            if (m.filled) {
              records = records.map((r) => (r.id === match.id ? m.record : r));
              updated++;
            }
          } else if (Object.keys(rec.fields).length > 0) {
            records = [...records, rec];
            addedIds.push(rec.id);
            added++;
          }
        }
        return { records, currentId: null };
      });
      if (thumbnail && addedIds.length) setThumbs((t) => ({ ...t, ...Object.fromEntries(addedIds.map((id) => [id, thumbnail])) }));
      if (added || updated) feedback();
      return { added, updated };
    },
    [update],
  );

  /**
   * Xử lý một ảnh (chụp, chọn, dán, chụp từ camera): đọc mã vạch, rồi TỰ ĐỘNG đọc chữ khi
   * mã vạch chưa đủ Serial / IMEI / Part No. (ảnh chụp màn hình Cài đặt không có mã vạch).
   */
  const processImage = useCallback(
    async (image: Blob, name: string): Promise<ImageResult> => {
      setBusy(`Đang đọc mã vạch: ${name}…`);
      try {
        const result = await decodePhoto(image);
        let recs = recordsFromPhoto(result.codes, name, newId);
        let usedOcr = false;
        const incomplete = recs.length === 0 || (recs.length === 1 && (!recs[0].fields.serial || !recs[0].fields.imei1 || !recs[0].fields.partNumber));
        if (ocrBase && incomplete) {
          setBusy(`Đang đọc chữ trên ảnh: ${name}…`);
          const x = await ocr(image);
          if (x) {
            usedOcr = true;
            if (recs.length === 1) recs = [applyExtraction(recs[0], x).record];
            else if (hasIdentity(x)) recs = [{ ...applyExtraction(emptyRecord(newId(), "PHOTO"), x).record, photoName: name }];
          }
        }
        const r = addRecords(recs, result.thumbnail);
        return { barcodes: result.codes.length, usedOcr, ...r };
      } finally {
        setBusy(null);
      }
    },
    [addRecords, ocr, ocrBase],
  );

  /** Dán văn bản: mỗi dòng nhiều mã = một máy; dòng một mã thì nối tiếp như quét liên tục. */
  const ingestText = useCallback(
    (text: string) => {
      let added = 0;
      const lines = splitPastedText(text);
      for (const tokens of lines) {
        if (tokens.length > 1) update((s) => ({ ...s, currentId: null }));
        added += ingestStream(tokens, "PASTE", "PASTE");
      }
      // Văn bản dài kiểu "Giới thiệu" sao chép từ máy: thử trích xuất theo nhãn
      if (added === 0) {
        const x = extractFromText(text);
        if (hasIdentity(x)) {
          const r = addRecords([applyExtraction(emptyRecord(newId(), "PASTE"), x, "PASTE").record]);
          added = r.added + r.updated;
        }
      }
      if (added) feedback();
      notify(added ? `Đã nhận ${added} mã` : "Không thấy mã mới trong nội dung vừa dán");
      return added;
    },
    [addRecords, ingestStream, notify, update],
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent | ReactClipboardEvent) => {
      const { images, text } = readClipboard(e);
      if (images.length === 0 && !text.trim()) return false;
      e.preventDefault();
      if (images.length) {
        for (const [i, img] of images.entries()) {
          const r = await processImage(img, `anh-dan-${i + 1}.png`);
          notify(r.added || r.updated ? `Ảnh dán: ${r.added} máy mới, ${r.updated} máy bổ sung` : "Không đọc được mã nào trên ảnh vừa dán");
        }
      } else {
        ingestText(text);
      }
      return true;
    },
    [ingestText, notify, processImage],
  );

  // Dán ở bất kỳ đâu trên trang (trừ khi đang sửa một ô của máy) → tự nhận diện
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".sc-card") || t?.dataset?.pasteIgnore) return;
      void handlePaste(e);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handlePaste]);

  const nextDevice = useCallback(() => {
    update((s) => ({ ...s, currentId: null }));
    notify("Sẵn sàng quét máy tiếp theo");
  }, [notify, update]);

  // Máy quét mã vạch USB/Bluetooth: gõ rất nhanh rồi Enter
  useEffect(() => {
    let buffer = "";
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const now = performance.now();
      if (now - last > 60) buffer = "";
      last = now;
      if (e.key === "Enter") {
        if (buffer.length >= 6) {
          const n = ingestStream([buffer], "HW_SCANNER", "HW_SCANNER");
          if (n) feedback();
          else notify(`Bỏ qua mã đã có: ${buffer}`);
        }
        buffer = "";
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ingestStream, notify]);

  /** Camera đọc được mã: thêm vào máy đang quét; nếu máy chưa có Part No. thì tự đọc chữ trên khung hình. */
  const onLiveCodes = useCallback(
    (codes: PositionedCode[], grab: () => Promise<Blob>) => {
      const next = mergeLiveFrame(sessionRef.current, codes, newId);
      if (!next.added) return;
      update(() => ({ records: next.records, currentId: next.currentId }));
      feedback();
      const id = sessionRef.current.currentId;
      const rec = sessionRef.current.records.find((r) => r.id === id);
      if (!ocrBase || !rec || rec.fields.partNumber || ocrTried.current.has(rec.id)) return;
      ocrTried.current.add(rec.id);
      void grab()
        .then((blob) => ocr(blob))
        .then((x) => {
          setBusy(null);
          if (!x) return;
          update((s) => ({ ...s, records: s.records.map((r) => (r.id === rec.id ? applyExtraction(r, x).record : r)) }));
        })
        .catch(() => setBusy(null));
    },
    [ocr, ocrBase, update],
  );

  /** Camera ở chế độ "Màn hình máy": đọc chữ trên khung hình, chỉ nhận khi có IMEI (Luhn) hoặc serial cạnh nhãn. */
  const onLiveScreen = useCallback(
    async (grab: () => Promise<Blob>) => {
      if (!ocrBase) return null;
      try {
        const x = await ocr(await grab());
        if (!x || !hasStrongIdentity(x)) return { added: 0, updated: 0 };
        return addRecords([applyExtraction(emptyRecord(newId(), "CAMERA"), x).record]);
      } finally {
        setBusy(null);
      }
    },
    [addRecords, ocr, ocrBase],
  );

  const records = session.records;
  const issuesById = useMemo(
    () => Object.fromEntries(records.map((r) => [r.id, validateRecord(r, records, expectedRegion)])),
    [records, expectedRegion],
  );
  const errorCount = Object.values(issuesById).reduce((n, list) => n + list.filter((i) => i.severity === "error").length, 0);

  const updateRecord = (id: string, fn: (r: DeviceRecord) => DeviceRecord) =>
    update((s) => ({ ...s, records: s.records.map((r) => (r.id === id ? fn(r) : r)) }));

  const removeRecord = (id: string) =>
    update((s) => ({ records: s.records.filter((r) => r.id !== id), currentId: s.currentId === id ? null : s.currentId }));

  const clearAll = () => {
    update(() => ({ records: [], currentId: null }));
    setThumbs({});
    ocrTried.current.clear();
    setConfirmClear(false);
  };

  const copyTable = async () => {
    const tsv = toTsv(records);
    try {
      await navigator.clipboard.writeText(tsv);
      notify("Đã sao chép — dán vào Excel/Google Sheets");
    } catch {
      setCopyFallback(tsv);
    }
  };

  const exportCsv = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    try {
      await saveFile(`quet-ma-${stamp}.csv`, toCsv(records));
    } catch {
      notify("Chưa tải được file — dùng nút Sao chép bảng");
    }
  };

  const ready = decoderState === "ready";

  return (
    <div className="sc-root">
      <header className="sc-head">
        <div>
          <h1 className="sc-title">Quét mã máy</h1>
          <p className="sc-sub">
            IMEI · Serial · Part No. — {records.length} máy
            {errorCount > 0 && <span className="sc-err-count"> · {errorCount} lỗi cần sửa</span>}
          </p>
        </div>
        <span className={`sc-engine sc-engine-${decoderState}`}>
          {decoderState === "loading" ? "Đang tải bộ giải mã…" : decoderState === "ready" ? "Sẵn sàng" : "Lỗi bộ giải mã"}
        </span>
      </header>

      <nav className="sc-tabs" role="tablist">
        {(
          [
            ["camera", "📷 Camera"],
            ["photo", "🖼️ Ảnh"],
            ["manual", "⌨️ Nhập tay / Dán"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`sc-tab ${mode === m ? "is-active" : ""}`} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </nav>

      {mode === "camera" && !liveCamera && (
        <section className="sc-panel">
          <p>Trang xem thử này không được phép mở camera trực tiếp.</p>
          <p className="sc-hint">
            Dùng tab <b>Ảnh</b> → <b>Chụp ảnh</b>: iPhone mở camera để chụp nhãn hộp, kết quả giống hệt.
          </p>
          <div className="sc-row">
            <button className="sc-btn sc-btn-primary" onClick={() => setMode("photo")}>
              Chuyển sang chụp ảnh
            </button>
          </div>
        </section>
      )}
      {mode === "camera" && liveCamera && (
        <CameraPanel
          ready={ready}
          busy={busy !== null}
          onCodes={onLiveCodes}
          onScreen={ocrBase ? onLiveScreen : undefined}
          onCapture={async (blob) => {
            const r = await processImage(blob, `camera-${new Date().toLocaleTimeString("vi-VN")}.jpg`);
            notify(
              r.added || r.updated
                ? `Đã đọc: ${r.added} máy mới, ${r.updated} máy bổ sung${r.usedOcr ? " (có đọc chữ)" : ""}`
                : "Vẫn chưa đọc được — thử lùi xa hơn, bật đèn, hoặc nhập tay",
            );
          }}
          onNextDevice={nextDevice}
          onManual={() => setMode("manual")}
          onSwitchToPhoto={() => setMode("photo")}
        />
      )}
      {mode === "photo" && (
        <PhotoPanel ready={ready} busy={busy !== null} hasOcr={Boolean(ocrBase)} sampleLabelUrl={sampleLabelUrl} onImage={processImage} />
      )}
      {mode === "manual" && (
        <ManualPanel
          onText={ingestText}
          onAddBlank={() => {
            const r = emptyRecord(newId(), "MANUAL");
            update((s) => ({ records: [...s.records, r], currentId: r.id }));
          }}
        />
      )}

      {busy && (
        <p className="sc-busy" role="status">
          <span className="sc-spinner" aria-hidden /> {busy}
        </p>
      )}

      <section className="sc-list" aria-label="Danh sách máy đã quét">
        {records.length === 0 ? (
          <div className="sc-empty">
            Chưa có máy nào. Quét nhãn sau hộp máy, chụp ảnh hộp, dán ảnh chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b>, hoặc nhập tay.
          </div>
        ) : (
          [...records].reverse().map((r) => {
            const index = records.indexOf(r) + 1;
            const issues = issuesById[r.id] ?? [];
            return (
              <article key={r.id} className={`sc-card ${r.id === session.currentId ? "is-current" : ""}`}>
                <div className="sc-card-head">
                  <strong>Máy #{index}</strong>
                  <span className="sc-origin">
                    {ORIGIN_LABEL[r.origin]}
                    {r.photoName ? ` · ${r.photoName}` : ""}
                  </span>
                  {r.id === session.currentId && <span className="sc-badge sc-badge-live">đang quét</span>}
                  <button className="sc-icon-btn" aria-label={`Xoá máy #${index}`} onClick={() => removeRecord(r.id)}>
                    ✕
                  </button>
                </div>
                <div className="sc-card-body">
                  {thumbs[r.id] && (
                    // ảnh thu nhỏ là data URL tạo trên máy — next/image không áp dụng; component còn dùng ngoài Next
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="sc-thumb" src={thumbs[r.id]} alt="" />
                  )}
                  <div className="sc-fields">
                    {FIELD_ORDER.filter((k) => k !== "eid" || r.fields.eid).map((k) => (
                      <FieldRow
                        key={`${k}:${r.fields[k]?.value ?? ""}`}
                        fieldKey={k}
                        record={r}
                        issues={issues.filter((i) => i.field === k)}
                        onChange={(v) => updateRecord(r.id, (rec) => setField(rec, k, v))}
                      />
                    ))}
                    <label className="sc-field">
                      <span className="sc-label">Ghi chú</span>
                      <input
                        className="sc-input sc-input-note"
                        value={r.note ?? ""}
                        placeholder="Tình trạng, pin, ngoại hình…"
                        onChange={(e) => updateRecord(r.id, (rec) => ({ ...rec, note: e.target.value }))}
                      />
                    </label>
                  </div>
                </div>
                {issues
                  .filter((i) => !i.field)
                  .map((i) => (
                    <p key={i.message} className={`sc-issue sc-issue-${i.severity}`}>
                      {i.message}
                    </p>
                  ))}
                {r.extras.length > 0 && <p className="sc-extras">Mã khác đọc được: {r.extras.join(" · ")}</p>}
              </article>
            );
          })
        )}
      </section>

      <footer className="sc-actions">
        <button className="sc-btn" disabled={!records.length} onClick={copyTable}>
          Sao chép bảng
        </button>
        <button className="sc-btn" disabled={!records.length} onClick={exportCsv}>
          Tải CSV
        </button>
        {confirmClear ? (
          <span className="sc-confirm">
            Xoá {records.length} máy?
            <button className="sc-btn sc-btn-danger" onClick={clearAll}>
              Xoá hết
            </button>
            <button className="sc-btn sc-btn-ghost" onClick={() => setConfirmClear(false)}>
              Giữ lại
            </button>
          </span>
        ) : (
          <button className="sc-btn sc-btn-ghost" disabled={!records.length} onClick={() => setConfirmClear(true)}>
            Xoá phiên
          </button>
        )}
      </footer>

      {copyFallback !== null && (
        <section className="sc-panel" aria-label="Sao chép thủ công">
          <p>Chọn toàn bộ nội dung dưới đây, sao chép rồi dán vào Excel:</p>
          <textarea
            className="sc-input sc-textarea"
            rows={6}
            readOnly
            data-paste-ignore="1"
            value={copyFallback}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="sc-row">
            <button className="sc-btn" onClick={() => setCopyFallback(null)}>
              Đóng
            </button>
          </div>
        </section>
      )}

      {toast && (
        <div className="sc-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  fieldKey,
  record,
  issues,
  onChange,
}: {
  fieldKey: FieldKey;
  record: DeviceRecord;
  issues: ReturnType<typeof validateRecord>;
  onChange: (v: string) => void;
}) {
  const f = record.fields[fieldKey];
  // key của FieldRow gồm cả giá trị → khi giá trị đổi từ bên ngoài, ô được tạo lại với nháp mới
  const [draft, setDraft] = useState(f?.value ?? "");
  const isImei = fieldKey === "imei1" || fieldKey === "imei2";
  const hasError = issues.some((i) => i.severity === "error");
  return (
    <label className="sc-field">
      <span className="sc-label">
        {FIELD_LABELS[fieldKey]}
        {f && <span className={`sc-badge ${SOURCE_BADGE[f.source].cls}`}>{SOURCE_BADGE[f.source].label}</span>}
      </span>
      <input
        className={`sc-input ${hasError ? "has-error" : issues.length ? "has-warning" : ""}`}
        value={draft}
        inputMode={isImei ? "numeric" : "text"}
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
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

type ZoomCaps = { min: number; max: number; step?: number };

type CameraTarget = "box" | "screen";

function CameraPanel({
  ready,
  busy,
  onCodes,
  onScreen,
  onCapture,
  onNextDevice,
  onManual,
  onSwitchToPhoto,
}: {
  ready: boolean;
  busy: boolean;
  onCodes: (codes: PositionedCode[], grab: () => Promise<Blob>) => void;
  /** Có = hỗ trợ đọc chữ trên màn hình máy (dạng 1). */
  onScreen?: (grab: () => Promise<Blob>) => Promise<{ added: number; updated: number } | null>;
  onCapture: (blob: Blob) => Promise<void>;
  onNextDevice: () => void;
  onManual: () => void;
  onSwitchToPhoto: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [zoom, setZoom] = useState<{ caps: ZoomCaps; value: number } | null>(null);
  const [lastSeen, setLastSeen] = useState<string[]>([]);
  const [lastReadAt, setLastReadAt] = useState(0);
  const [now, setNow] = useState(0);
  const [resolution, setResolution] = useState("");
  const [target, setTarget] = useState<CameraTarget>("box");
  const [reading, setReading] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
    setTorch(null);
    setZoom(null);
  }, []);

  useEffect(() => stop, [stop]);

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setError("Trình duyệt hoặc trang này không cho mở camera trực tiếp.");
      return;
    }
    setState("starting");
    try {
      // Độ phân giải càng cao càng đọc được mã mảnh trên nhãn Apple; trình duyệt tự hạ nếu không hỗ trợ
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; zoom?: ZoomCaps; focusMode?: string[] };
      if (caps.focusMode?.includes("continuous")) {
        track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      setTorch(caps.torch ? false : null);
      setZoom(caps.zoom && caps.zoom.max >= 1.5 ? { caps: caps.zoom, value: 1 } : null);
      setResolution(`${video.videoWidth}×${video.videoHeight}`);
      const t = Date.now();
      setLastReadAt(t);
      setNow(t);
      setState("running");
    } catch (e) {
      setState("error");
      const name = (e as DOMException)?.name;
      setError(
        name === "NotAllowedError" ? "Chưa được cấp quyền camera." : name === "NotFoundError" ? "Không tìm thấy camera." : "Không mở được camera trực tiếp.",
      );
    }
  };

  const grab = useCallback(() => captureVideoFrame(videoRef.current!), []);

  // Vòng quét: đọc liên tục, tự động — không cần bấm nút
  useEffect(() => {
    if (state !== "running" || !ready) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video) {
        try {
          const codes = await decodeVideoFrame(video);
          if (codes.length) {
            setLastSeen(codes.map((c) => c.text));
            setLastReadAt(Date.now());
            onCodes(codes, grab);
          }
        } catch {
          /* khung hình lỗi — bỏ qua */
        }
      }
      setNow(Date.now());
      timer = window.setTimeout(tick, 150);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [state, ready, onCodes, grab]);

  // Chế độ "Màn hình máy": đọc chữ liên tục (mỗi lần ~1–2 giây), không cần bấm
  useEffect(() => {
    if (state !== "running" || target !== "screen" || !onScreen) return;
    let stopped = false;
    let timer = 0;
    const loop = async () => {
      if (stopped) return;
      setReading(true);
      try {
        const r = await onScreen(grab);
        if (r && (r.added || r.updated)) setLastReadAt(Date.now());
      } catch {
        /* khung hình lỗi — bỏ qua */
      }
      setReading(false);
      if (!stopped) timer = window.setTimeout(loop, 500);
    };
    timer = window.setTimeout(loop, 400);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      setReading(false);
    };
  }, [state, target, onScreen, grab]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const toggleZoom = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoom) return;
    const next = zoom.value > 1 ? 1 : Math.min(2, zoom.caps.max);
    try {
      await track.applyConstraints({ advanced: [{ zoom: next } as MediaTrackConstraintSet] });
      setZoom({ ...zoom, value: next });
    } catch {
      setZoom(null);
    }
  };

  const stuck = state === "running" && now - lastReadAt > (target === "screen" ? 9000 : 5000);

  return (
    <section className="sc-panel">
      {onScreen && (
        <div className="sc-seg" role="radiogroup" aria-label="Quét cái gì">
          <button role="radio" aria-checked={target === "box"} className={target === "box" ? "is-active" : ""} onClick={() => setTarget("box")}>
            Sau hộp <span>mã vạch</span>
          </button>
          <button role="radio" aria-checked={target === "screen"} className={target === "screen" ? "is-active" : ""} onClick={() => setTarget("screen")}>
            Màn hình máy <span>IMEI, Serial</span>
          </button>
        </div>
      )}
      <div className={`sc-video-wrap ${state === "running" ? "is-running" : ""}`}>
        <video ref={videoRef} className="sc-video" playsInline muted autoPlay />
        {state === "running" && (
          <div className={`sc-reticle ${target === "screen" ? "is-screen" : ""} ${now - lastReadAt < 800 ? "is-hit" : ""}`} aria-hidden />
        )}
        {state === "running" && (
          <span className="sc-live-pill">
            ● {target === "screen" ? (reading ? "Đang đọc chữ trên màn hình…" : "Đang tự đọc màn hình") : "Đang tự quét mã vạch"}
            {resolution ? ` · ${resolution}` : ""}
          </span>
        )}
        {state !== "running" && (
          <div className="sc-video-placeholder">
            {state === "error" ? (
              <>
                <p>{error}</p>
                <p className="sc-muted">
                  Dùng tab <b>Ảnh</b> → <b>Chụp ảnh</b>: iPhone sẽ mở camera để chụp nhãn hộp.
                </p>
                <button className="sc-btn" onClick={onSwitchToPhoto}>
                  Chuyển sang chụp ảnh
                </button>
              </>
            ) : (
              <button className="sc-btn sc-btn-primary" disabled={state === "starting"} onClick={start}>
                {state === "starting" ? "Đang mở camera…" : "Bật camera quét"}
              </button>
            )}
          </div>
        )}
      </div>
      {state === "running" && (
        <>
          <div className="sc-row">
            <button className="sc-btn sc-btn-primary" onClick={onNextDevice}>
              Máy tiếp theo
            </button>
            <button className="sc-btn" disabled={busy} onClick={async () => onCapture(await grab())}>
              📸 Chụp &amp; đọc kỹ
            </button>
            <button className="sc-btn" onClick={onManual}>
              ⌨ Nhập tay
            </button>
          </div>
          <div className="sc-row">
            {torch !== null && (
              <button className="sc-btn sc-btn-ghost" onClick={toggleTorch}>
                {torch ? "Tắt đèn" : "Bật đèn"}
              </button>
            )}
            {zoom && (
              <button className="sc-btn sc-btn-ghost" onClick={toggleZoom}>
                {zoom.value > 1 ? "Thu về 1×" : "Phóng to 2×"}
              </button>
            )}
            <button className="sc-btn sc-btn-ghost" onClick={stop}>
              Tắt camera
            </button>
          </div>
        </>
      )}
      {target === "screen" ? (
        <p className={`sc-hint ${stuck ? "sc-hint-warn" : ""}`}>
          {stuck ? (
            <>
              Chưa đọc được. Mở <b>Cài đặt › Cài đặt chung › Giới thiệu</b> trên máy cần quét, để màn hình đủ sáng, giữ thẳng và tránh loá; lùi ra 20–30 cm để thấy cả dòng IMEI / Số sê-ri.
            </>
          ) : (
            <>
              Hướng camera vào màn hình <b>Giới thiệu</b> của máy cần quét — IMEI, IMEI2, Số sê-ri, Số kiểu máy được <b>tự đọc</b>. Kéo màn hình máy lên/xuống để thấy hết các dòng.
            </>
          )}
        </p>
      ) : stuck ? (
        <p className="sc-hint sc-hint-warn">
          Chưa đọc được mã nào. Lùi máy ra <b>20–30 cm</b> (camera iPhone Pro không lấy nét quá gần){zoom ? <>, bấm <b>Phóng to 2×</b></> : null}, bật đèn nếu tối, hoặc bấm{" "}
          <b>📸 Chụp &amp; đọc kỹ</b> để đọc cả chữ trên nhãn.
        </p>
      ) : (
        <p className="sc-hint">
          Đưa nhãn sau hộp vào khung — mã được đọc <b>tự động</b>, không cần bấm. Part No. chỉ in bằng chữ sẽ được tự đọc chữ sau khi bắt được mã vạch.
          {lastSeen.length > 0 && <span className="sc-muted"> Vừa thấy: {lastSeen.join(" · ")}</span>}
        </p>
      )}
    </section>
  );
}

function PhotoPanel({
  ready,
  busy,
  hasOcr,
  sampleLabelUrl,
  onImage,
}: {
  ready: boolean;
  busy: boolean;
  hasOcr: boolean;
  sampleLabelUrl?: string;
  onImage: (image: Blob, name: string) => Promise<ImageResult>;
}) {
  const [log, setLog] = useState<{ name: string; text: string; ok: boolean }[]>([]);

  const describe = (r: ImageResult) =>
    r.added || r.updated
      ? `${r.barcodes} mã vạch${r.usedOcr ? " + đọc chữ" : ""} → ${r.added} máy mới${r.updated ? `, ${r.updated} máy bổ sung` : ""}`
      : r.barcodes
        ? `${r.barcodes} mã vạch → 0 máy mới (đã có trong danh sách)`
        : hasOcr
          ? "Không thấy mã vạch hay IMEI/Serial — chụp gần hơn, đủ sáng, nhãn phẳng"
          : "Không thấy mã vạch — chụp gần hơn, đủ sáng, nhãn phẳng, tránh loá";

  const run = async (image: Blob, name: string) => {
    try {
      const r = await onImage(image, name);
      setLog((l) => [{ name, text: describe(r), ok: r.added + r.updated > 0 }, ...l].slice(0, 30));
    } catch {
      setLog((l) => [{ name, text: "Không mở được ảnh này", ok: false }, ...l].slice(0, 30));
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) await run(file, file.name || `anh-${Date.now()}.jpg`);
  };

  return (
    <section className="sc-panel">
      <div className="sc-row">
        <label className={`sc-btn sc-btn-primary ${!ready ? "is-disabled" : ""}`}>
          📷 Chụp ảnh
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            disabled={!ready}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label className={`sc-btn ${!ready ? "is-disabled" : ""}`}>
          🖼️ Chọn ảnh / ảnh chụp màn hình
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={!ready}
            data-testid="photo-input"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <div
        className="sc-paste-zone"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Vùng dán ảnh hoặc mã"
        inputMode="none"
        onInput={(e) => (e.currentTarget.textContent = "")}
      >
        Chạm vào đây → <b>Dán</b> ảnh chụp màn hình hoặc mã đã sao chép — tự nhận diện ngay.
      </div>
      <p className="sc-hint">
        Chọn ảnh là <b>tự đọc ngay</b>: mã vạch trên nhãn hộp{hasOcr ? <>, và chữ trên ảnh chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b> (IMEI, Số sê-ri, Số kiểu máy)</> : null}. Ảnh không rời
        khỏi máy của bạn.
      </p>
      {sampleLabelUrl && (
        <div className="sc-sample">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sampleLabelUrl} alt="Nhãn hộp mẫu với mã vạch Part No., Serial, IMEI và UPC" />
          <div>
            <p>
              <b>Chưa có hộp máy?</b> Thử với nhãn mẫu (2 máy, số liệu minh hoạ).
            </p>
            <button className="sc-btn" disabled={!ready || busy} onClick={async () => run(await rasterizeImageUrl(sampleLabelUrl), "Nhãn mẫu")}>
              Thử với nhãn mẫu
            </button>
          </div>
        </div>
      )}
      {log.length > 0 && (
        <ul className="sc-log">
          {log.map((l, i) => (
            <li key={i} className={l.ok ? "" : "is-bad"}>
              <b>{l.name}</b>: {l.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ManualPanel({ onText, onAddBlank }: { onText: (text: string) => number; onAddBlank: () => void }) {
  const [code, setCode] = useState("");
  const [text, setText] = useState("");

  /** Ô nhập một mã: IMEI (có số kiểm tra) hoặc Part No. đủ mẫu là tự thêm; mã khác bấm Enter. */
  const onCodeChange = (value: string) => {
    const c = classifyCode(value);
    if (c.kind === "IMEI" || c.kind === "PART_NUMBER") {
      onText(c.value);
      setCode("");
    } else {
      setCode(value);
    }
  };

  return (
    <section className="sc-panel">
      <label className="sc-field">
        <span className="sc-label">Nhập một mã — IMEI đủ 15 số hợp lệ sẽ tự thêm; Serial thì bấm Enter</span>
        <input
          className="sc-input"
          value={code}
          placeholder="IMEI, Serial hoặc Part No."
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          onChange={(e) => onCodeChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.trim()) {
              onText(code);
              setCode("");
            }
          }}
        />
      </label>
      <label className="sc-field">
        <span className="sc-label">Hoặc dán danh sách (Excel, email, tin nhắn, ảnh chụp màn hình) — tự nhận diện khi dán</span>
        <textarea
          className="sc-input sc-textarea"
          rows={3}
          value={text}
          placeholder={"F2LXQ7Y9KD\t350000000000006\tMDEM1LL/A\nC02XL0GTJGH5, 350000000000014"}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="sc-row">
        <button
          className="sc-btn"
          disabled={!text.trim()}
          onClick={() => {
            onText(text);
            setText("");
          }}
        >
          Thêm từ văn bản đã gõ
        </button>
        <button className="sc-btn" onClick={onAddBlank}>
          + Thêm máy trống, nhập từng ô
        </button>
      </div>
      <p className="sc-hint">
        Có máy quét mã vạch USB/Bluetooth? Cứ quét khi đang ở trang này (không cần bấm vào ô nào) — mã sẽ tự vào đúng ô.
      </p>
    </section>
  );
}
