"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  emptyRecord,
  mergeStream,
  recordsFromPhoto,
  setField,
  toCsv,
  toTsv,
  validateRecord,
  type DeviceRecord,
  type FieldKey,
  type FieldSource,
  type StreamState,
} from "@/domain/scan-session";
import { splitPastedText } from "@/domain/identifiers";
import { decodeImageUrl, decodePhoto, decodeVideoFrame, initDecoder, type WasmSource } from "./decoder";
import "./scanner.css";

type Mode = "camera" | "photo" | "manual";

export interface ScannerProps {
  wasm: WasmSource;
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

export function Scanner({
  wasm,
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
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  /** Mọi thay đổi phiên đi qua đây để ref (dùng trong vòng quét) luôn khớp state. */
  const update = useCallback((fn: (s: StreamState) => StreamState) => {
    sessionRef.current = fn(sessionRef.current);
    setSession(sessionRef.current);
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessionRef.current));
    } catch {
      /* bỏ qua: chỉ là tiện ích lưu tạm trên thiết bị */
    }
  }, [storageKey]);

  useEffect(() => {
    initDecoder(wasm).then(
      () => setDecoderState("ready"),
      () => setDecoderState("error"),
    );
  }, [wasm]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  /** Đưa một loạt mã (camera, máy quét, dán) vào phiên. Trả về số mã mới. */
  const ingestStream = useCallback((codes: string[], source: FieldSource, origin: DeviceRecord["origin"]) => {
    const next = mergeStream(sessionRef.current, codes, source, origin, newId);
    if (next.added.length > 0) update(() => ({ records: next.records, currentId: next.currentId }));
    return next.added.length;
  }, [update]);

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
            Dùng tab <b>Ảnh</b> → <b>Chụp ảnh</b>: iPhone mở camera để chụp nhãn hộp, kết quả giống hệt. Quét liên tục bằng camera có trong ứng dụng iPre.
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
          ready={decoderState === "ready"}
          onCodes={(codes) => {
            const n = ingestStream(codes, "BARCODE", "CAMERA");
            if (n) feedback();
          }}
          onNextDevice={nextDevice}
          onSwitchToPhoto={() => setMode("photo")}
        />
      )}
      {mode === "photo" && (
        <PhotoPanel
          ready={decoderState === "ready"}
          sampleLabelUrl={sampleLabelUrl}
          onPhoto={(name, result) => {
            const recs = recordsFromPhoto(result.codes, name, newId);
            const known = new Set(sessionRef.current.records.flatMap((r) => Object.values(r.fields).map((f) => f?.value)));
            const fresh = recs.filter((r) => Object.values(r.fields).some((f) => f && !known.has(f.value)));
            if (fresh.length) {
              update((s) => ({ records: [...s.records, ...fresh], currentId: null }));
              setThumbs((t) => ({ ...t, ...Object.fromEntries(fresh.map((r) => [r.id, result.thumbnail])) }));
              feedback();
            }
            return { found: result.codes.length, devices: fresh.length, duplicates: recs.length - fresh.length };
          }}
        />
      )}
      {mode === "manual" && (
        <ManualPanel
          onPaste={(text) => {
            let added = 0;
            for (const tokens of splitPastedText(text)) {
              // mỗi dòng nhiều mã = một máy; dòng chỉ một mã thì nối tiếp như quét liên tục
              if (tokens.length > 1) update((s) => ({ ...s, currentId: null }));
              added += ingestStream(tokens, "PASTE", "PASTE");
            }
            notify(added ? `Đã thêm ${added} mã` : "Không có mã mới");
          }}
          onAddBlank={() => {
            const r = emptyRecord(newId(), "MANUAL");
            update((s) => ({ records: [...s.records, r], currentId: r.id }));
          }}
        />
      )}

      <section className="sc-list" aria-label="Danh sách máy đã quét">
        {records.length === 0 ? (
          <div className="sc-empty">
            Chưa có máy nào. Quét nhãn sau hộp máy, chụp ảnh hộp, chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b>, hoặc nhập tay.
          </div>
        ) : (
          [...records].reverse().map((r) => {
            const index = records.indexOf(r) + 1;
            const issues = issuesById[r.id] ?? [];
            return (
              <article key={r.id} className={`sc-card ${r.id === session.currentId ? "is-current" : ""}`}>
                <div className="sc-card-head">
                  <strong>Máy #{index}</strong>
                  <span className="sc-origin">{ORIGIN_LABEL[r.origin]}{r.photoName ? ` · ${r.photoName}` : ""}</span>
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
                {issues.filter((i) => !i.field).map((i) => (
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

function CameraPanel({
  ready,
  onCodes,
  onNextDevice,
  onSwitchToPhoto,
}: {
  ready: boolean;
  onCodes: (codes: string[]) => void;
  onNextDevice: () => void;
  onSwitchToPhoto: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [lastSeen, setLastSeen] = useState<string[]>([]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
    setTorch(null);
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTorch(caps.torch ? false : null);
      setState("running");
    } catch (e) {
      setState("error");
      const name = (e as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "Chưa được cấp quyền camera."
          : name === "NotFoundError"
            ? "Không tìm thấy camera."
            : "Không mở được camera trực tiếp.",
      );
    }
  };

  // Vòng quét: ~5 khung hình/giây, bỏ qua khung khi khung trước chưa xong
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
            const texts = codes.map((c) => c.text);
            setLastSeen(texts);
            onCodes(texts);
          }
        } catch {
          /* khung hình lỗi — bỏ qua */
        }
      }
      timer = window.setTimeout(tick, 200);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [state, ready, onCodes]);

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

  return (
    <section className="sc-panel">
      <div className={`sc-video-wrap ${state === "running" ? "is-running" : ""}`}>
        <video ref={videoRef} className="sc-video" playsInline muted autoPlay />
        {state === "running" && <div className="sc-reticle" aria-hidden />}
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
        <div className="sc-row">
          <button className="sc-btn sc-btn-primary" onClick={onNextDevice}>
            Máy tiếp theo
          </button>
          {torch !== null && (
            <button className="sc-btn" onClick={toggleTorch}>
              {torch ? "Tắt đèn" : "Bật đèn"}
            </button>
          )}
          <button className="sc-btn sc-btn-ghost" onClick={stop}>
            Tắt camera
          </button>
        </div>
      )}
      <p className="sc-hint">
        Đưa camera song song với nhãn sau hộp, cách 10–20 cm. Các mã trên cùng một hộp được gom vào một máy; gặp serial mới sẽ tự sang máy mới.
        {lastSeen.length > 0 && <span className="sc-muted"> Vừa thấy: {lastSeen.join(" · ")}</span>}
      </p>
    </section>
  );
}

function PhotoPanel({
  ready,
  sampleLabelUrl,
  onPhoto,
}: {
  ready: boolean;
  sampleLabelUrl?: string;
  onPhoto: (name: string, result: Awaited<ReturnType<typeof decodePhoto>>) => { found: number; devices: number; duplicates: number };
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ name: string; text: string; ok: boolean }[]>([]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const [i, file] of Array.from(files).entries()) {
      setBusy(`Đang đọc ảnh ${i + 1}/${files.length}…`);
      const name = file.name || `anh-${Date.now()}.jpg`;
      try {
        const result = await decodePhoto(file);
        const s = onPhoto(name, result);
        const text =
          s.found === 0
            ? "Không thấy mã vạch — chụp gần hơn, đủ sáng, nhãn phẳng, tránh loá"
            : `${s.found} mã → ${s.devices} máy mới${s.duplicates ? `, ${s.duplicates} máy đã có` : ""}`;
        setLog((l) => [{ name, text, ok: s.found > 0 }, ...l].slice(0, 30));
      } catch {
        setLog((l) => [{ name, text: "Không mở được ảnh này", ok: false }, ...l].slice(0, 30));
      }
    }
    setBusy(null);
  };

  const trySample = async () => {
    if (!sampleLabelUrl) return;
    setBusy("Đang đọc nhãn mẫu…");
    try {
      const result = await decodeImageUrl(sampleLabelUrl);
      const s = onPhoto("nhan-mau.svg", result);
      setLog((l) => [{ name: "Nhãn mẫu", text: `${s.found} mã → ${s.devices} máy mới${s.duplicates ? `, ${s.duplicates} máy đã có` : ""}`, ok: s.found > 0 }, ...l]);
    } catch {
      setLog((l) => [{ name: "Nhãn mẫu", text: "Không đọc được nhãn mẫu", ok: false }, ...l]);
    }
    setBusy(null);
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
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label className={`sc-btn ${!ready ? "is-disabled" : ""}`}>
          🖼️ Chọn nhiều ảnh
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={!ready}
            data-testid="photo-input"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {sampleLabelUrl && (
        <div className="sc-sample">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sampleLabelUrl} alt="Nhãn hộp mẫu với mã vạch Part No., Serial, IMEI và UPC" />
          <div>
            <p>
              <b>Chưa có hộp máy?</b> Bấm thử với nhãn mẫu (2 máy, số liệu minh hoạ), hoặc mở nhãn này trên máy tính rồi chụp bằng điện thoại.
            </p>
            <button className="sc-btn" disabled={!ready || busy !== null} onClick={trySample}>
              Thử với nhãn mẫu
            </button>
          </div>
        </div>
      )}
      {busy && <p className="sc-muted">{busy}</p>}
      <p className="sc-hint">
        Chụp nhãn sau hộp máy, hoặc chọn ảnh forwarder gửi. Ảnh có nhiều hộp sẽ được tách thành nhiều máy. Ảnh không rời khỏi điện thoại của bạn.
      </p>
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

function ManualPanel({ onPaste, onAddBlank }: { onPaste: (text: string) => void; onAddBlank: () => void }) {
  const [text, setText] = useState("");
  return (
    <section className="sc-panel">
      <label className="sc-field">
        <span className="sc-label">Dán danh sách mã (từ Excel, email, tin nhắn) — mỗi dòng một máy</span>
        <textarea
          className="sc-input sc-textarea"
          rows={4}
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
          className="sc-btn sc-btn-primary"
          disabled={!text.trim()}
          onClick={() => {
            onPaste(text);
            setText("");
          }}
        >
          Thêm từ văn bản
        </button>
        <button className="sc-btn" onClick={onAddBlank}>
          + Thêm máy, nhập tay
        </button>
      </div>
      <p className="sc-hint">
        Có máy quét mã vạch USB/Bluetooth? Cứ quét khi đang ở trang này (không cần bấm vào ô nào) — mã sẽ tự vào đúng ô.
      </p>
    </section>
  );
}
