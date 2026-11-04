"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
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
import { extractFromText, hasIdentity, isComplete, mergeExtractions } from "@/domain/text-extract";
import { acceptedAsExtraction, addReading, emptyVotes, hasNew, isDeviceComplete, type Accepted, type ScreenVotes } from "@/domain/screen-votes";
import { captureVideoFrame, decodePhoto, decodeVideoFrame, initDecoder, rasterizeImageUrl, type WasmSource } from "./decoder";
import { recognizeCanvas, recognizeSplit, recognizeText, warmOcr, type OcrLine } from "./ocr";
import { findTextRegion, inkLineHeight, sharpness, shiftEstimate, toGray, type Gray, type TextRegion } from "./frame-analysis";
import { haptic, unlockFeedback } from "./haptics";
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
  /** Hiện thông tin danh mục của Part No. vừa đọc (cấu hình, cân nặng; mã lạ → gợi ý gán). Bản độc lập không có. */
  renderPartNumberInfo?: (partNumber: string) => ReactNode;
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
  haptic("tick");
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

export interface ScreenReadResult {
  ok: boolean;
  /** giá trị mới đọc được 1 lần, đang chờ lần đọc thứ hai xác nhận */
  pending: string[];
  accepted: Accepted;
  newly: Accepted;
  /**
   * Dải dọc (tỉ lệ 0–1 của ảnh vừa đọc) chứa các dòng còn chờ xác nhận (Serial, Part No.) — lần đọc sau chỉ cần
   * đọc lại đúng dải này (2 dòng, nhanh gấp nhiều lần đọc cả màn hình). Không có = lần sau đọc cả vùng.
   */
  focus?: { y0: number; y1: number };
}

/** So khớp lỏng giữa dòng OCR và giá trị đã chuẩn hoá (OCR hay lẫn O/0, I/1, bỏ khoảng trắng). */
function lineHas(line: string, value: string): boolean {
  const norm = (t: string) => t.toUpperCase().replace(/\s+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return norm(line).includes(norm(value));
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
  renderPartNumberInfo,
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
  /** Phiếu bầu của các lần chụp màn hình máy (chế độ "Màn hình máy") cho máy đang quét. */
  const votesRef = useRef<ScreenVotes>(emptyVotes());

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

  /**
   * Đọc chữ trên ảnh: trước hết tự tìm VÙNG CHỮ (vd màn hình máy trong ảnh chụp), cắt ở độ phân giải gốc,
   * phóng to rồi đọc; không ra IMEI/Serial thì đọc cả ảnh. Trả về null khi không có bộ đọc chữ hoặc lỗi.
   */
  const ocr = useCallback(
    async (image: Blob) => {
      if (!ocrBase) return null;
      const progress = (p: number) => setBusy(`Đang tải bộ đọc chữ (lần đầu)… ${Math.round(p * 100)}%`);
      try {
        const crop = await cropTextRegion(image);
        let first: ReturnType<typeof extractFromText> | null = null;
        if (crop) {
          first = extractFromText(await recognizeCanvas(ocrBase, crop, progress, "photo"), { ocr: true });
          if (isComplete(first)) return first;
        }
        // vùng cắt chưa đọc đủ (hoặc không tìm được vùng) → đọc thêm cả ảnh rồi GỘP, không bỏ kết quả đã có
        const whole = extractFromText(await recognizeText(ocrBase, image, progress), { ocr: true });
        return first ? mergeExtractions(first, whole) : whole;
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
      if (thumbnail && addedIds.length)
        setThumbs((t) => ({
          ...t,
          ...Object.fromEntries(addedIds.map((id) => [id, thumbnail])),
        }));
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
            else if (hasIdentity(x))
              recs = [
                {
                  ...applyExtraction(emptyRecord(newId(), "PHOTO"), x).record,
                  photoName: name,
                },
              ];
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
    votesRef.current = emptyVotes();
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
          update((s) => ({
            ...s,
            records: s.records.map((r) => (r.id === rec.id ? applyExtraction(r, x).record : r)),
          }));
        })
        .catch(() => setBusy(null));
    },
    [ocr, ocrBase, update],
  );

  /**
   * Camera tự chụp vùng chữ (khi đã đứng yên, đủ nét) → đọc chữ → bỏ phiếu → chỉ ghi giá trị đã chốt
   * vào MÁY ĐANG QUÉT. Đọc sai lẻ tẻ không tạo máy mới; gặp serial/IMEI khác hẳn mới sang máy mới.
   */
  const onScreenCapture = useCallback(
    async (canvas: HTMLCanvasElement): Promise<ScreenReadResult> => {
      if (!ocrBase)
        return {
          ok: false,
          pending: [],
          accepted: { imeis: [] },
          newly: { imeis: [] },
        };
      let text = "";
      let lines: OcrLine[] = [];
      try {
        ({ text, lines } = await recognizeSplit(ocrBase, canvas, (p) => setBusy(`Đang tải bộ đọc chữ (lần đầu)… ${Math.round(p * 100)}%`)));
      } catch {
        return {
          ok: false,
          pending: [],
          accepted: votesRef.current.accepted,
          newly: { imeis: [] },
        };
      } finally {
        setBusy(null);
      }
      const x = extractFromText(text, { ocr: true });
      let r = addReading(votesRef.current, x);
      if (r.otherDevice) {
        // máy khác: chốt máy cũ, bắt đầu máy mới với phiếu bầu mới
        update((s) => ({ ...s, currentId: null }));
        r = addReading(emptyVotes(), x);
      }
      votesRef.current = r.votes;
      const acc = r.votes.accepted;
      if (acc.serial || acc.imeis.length) {
        update((s) => {
          const probe = applyExtraction(emptyRecord("probe", "CAMERA"), acceptedAsExtraction(acc)).record;
          const base = s.records.find((rec) => rec.id === s.currentId) ?? findMatch(s.records, probe) ?? emptyRecord(newId(), "CAMERA");
          const res = applyExtraction(base, acceptedAsExtraction(acc));
          const exists = s.records.some((rec) => rec.id === base.id);
          return {
            records: exists ? s.records.map((rec) => (rec.id === base.id ? res.record : rec)) : [...s.records, res.record],
            currentId: base.id,
          };
        });
        if (r.newly.serial || r.newly.imeis.length) haptic("success");
        else if (hasNew(r.newly)) haptic("tick");
      }
      // giá trị đang chờ xác nhận (mới đọc được 1 lần)
      const pending: string[] = [];
      if (x.serial && x.serial !== acc.serial) pending.push(`Serial ${x.serial}`);
      if (x.partNumber && x.partNumber !== acc.partNumber) pending.push(`Part No. ${x.partNumber}`);
      // dòng nào chứa giá trị đang chờ → lần sau chỉ đọc lại các dòng đó
      const want = [
        x.serial && x.serial !== acc.serial ? x.serial : null,
        x.partNumber && x.partNumber !== acc.partNumber ? x.partNumber.slice(0, 5) : null,
      ].filter((v): v is string => Boolean(v));
      const hit = lines.filter((l) => want.some((v) => lineHas(l.text, v)));
      const focus =
        want.length && want.every((v) => hit.some((l) => lineHas(l.text, v))) && canvas.height > 0
          ? { y0: Math.min(...hit.map((l) => l.y0)) / canvas.height, y1: Math.max(...hit.map((l) => l.y1)) / canvas.height }
          : undefined;
      return { ok: true, pending, accepted: acc, newly: r.newly, focus };
    },
    [ocrBase, update],
  );

  const onWarmOcr = useMemo(() => (ocrBase ? () => void warmOcr(ocrBase) : undefined), [ocrBase]);

  const records = session.records;
  const issuesById = useMemo(() => Object.fromEntries(records.map((r) => [r.id, validateRecord(r, records, expectedRegion)])), [records, expectedRegion]);
  const errorCount = Object.values(issuesById).reduce((n, list) => n + list.filter((i) => i.severity === "error").length, 0);

  const updateRecord = (id: string, fn: (r: DeviceRecord) => DeviceRecord) =>
    update((s) => ({
      ...s,
      records: s.records.map((r) => (r.id === id ? fn(r) : r)),
    }));

  const removeRecord = (id: string) =>
    update((s) => ({
      records: s.records.filter((r) => r.id !== id),
      currentId: s.currentId === id ? null : s.currentId,
    }));

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
          onScreenCapture={ocrBase ? onScreenCapture : undefined}
          onWarmOcr={onWarmOcr}
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
      {mode === "photo" && <PhotoPanel ready={ready} busy={busy !== null} hasOcr={Boolean(ocrBase)} sampleLabelUrl={sampleLabelUrl} onImage={processImage} />}
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
                        onChange={(e) =>
                          updateRecord(r.id, (rec) => ({
                            ...rec,
                            note: e.target.value,
                          }))
                        }
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
                {renderPartNumberInfo && r.fields.partNumber?.value && renderPartNumberInfo(r.fields.partNumber.value)}
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
          <textarea className="sc-input sc-textarea" rows={6} readOnly data-paste-ignore="1" value={copyFallback} onFocus={(e) => e.currentTarget.select()} />
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
  onScreenCapture,
  onWarmOcr,
  onCapture,
  onNextDevice,
  onManual,
  onSwitchToPhoto,
}: {
  ready: boolean;
  busy: boolean;
  onCodes: (codes: PositionedCode[], grab: () => Promise<Blob>) => void;
  /** Có = hỗ trợ đọc chữ trên màn hình máy (dạng 1): nhận vùng chữ đã cắt, phóng to. */
  onScreenCapture?: (canvas: HTMLCanvasElement) => Promise<ScreenReadResult>;
  /** Khởi tạo sẵn bộ đọc chữ khi chọn "Màn hình máy" — lần chụp đầu khỏi chờ tải. */
  onWarmOcr?: () => void;
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
  /** tăng mỗi lần bấm "Máy tiếp theo" → khởi động lại vòng đọc màn hình (sau khi đã tự dừng) */
  const [round, setRound] = useState(0);
  const nextDevice = () => {
    onNextDevice();
    setScan({
      phase: "searching",
      box: null,
      pending: [],
      accepted: { imeis: [] },
      flash: 0,
    });
    setRound((r) => r + 1);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scan, setScan] = useState<ScreenScanState>({
    phase: "searching",
    box: null,
    pending: [],
    accepted: { imeis: [] },
    flash: 0,
  });

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
    setTorch(null);
    setZoom(null);
  }, []);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (target === "screen") onWarmOcr?.(); // gọi lại nhiều lần cũng không sao: bộ đọc chỉ tạo một lần
  }, [target, onWarmOcr]);

  const start = async () => {
    setError(null);
    unlockFeedback(); // mở khoá âm thanh / rung trong lúc người dùng chạm
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
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as {
        torch?: boolean;
        zoom?: ZoomCaps;
        focusMode?: string[];
      };
      if (caps.focusMode?.includes("continuous")) {
        track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
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

  // Vòng quét mã vạch: đọc liên tục, tự động — không cần bấm nút.
  // TẮT ở chế độ "Màn hình máy": màn hình Cài đặt không có mã vạch, mà mỗi lần giải mã khung 4K (tryHarder)
  // chiếm luồng chính và CPU — làm chậm hẳn việc tìm vùng chữ và đọc chữ trên điện thoại.
  useEffect(() => {
    if (state !== "running" || !ready || target === "screen") return;
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
  }, [state, ready, target, onCodes, grab]);

  // Chế độ "Màn hình máy" — luồng kiểu app quét tài liệu:
  // tìm vùng chữ → chờ đứng yên & đủ nét → tự chụp vùng đó ở độ phân giải gốc → đọc chữ → bỏ phiếu
  useEffect(() => {
    if (state !== "running" || target !== "screen" || !onScreenCapture) return;
    let stopped = false;
    let timer = 0;
    let prev: Gray | null = null;
    let steady = 0;
    let reading = false; // mỗi lần chỉ đọc MỘT khung (khung đó được chia đôi, đọc song song — xem recognizeSplit)
    let quietAfter = 0; // số lần đọc liên tiếp (sau khi có serial) không thêm được gì mới
    let regionSince = 0;
    let lastShot = 0;
    let blurSkips = 0;
    let focus: Band | undefined; // các dòng còn chờ xác nhận — lần đọc sau chỉ đọc dải này
    const sharpWin: number[] = [];
    const small = document.createElement("canvas");

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const wrap = wrapRef.current;
      if (video && wrap && video.videoWidth) {
        const W = 480;
        const f = video.videoWidth / W;
        small.width = W;
        small.height = Math.round(video.videoHeight / f);
        const ctx = small.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(video, 0, 0, small.width, small.height);
        const gray = toGray(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
        const region = findTextRegion(gray);
        // rung = độ dịch ước lượng (≈ px khung phân tích), không phải chênh lệch độ sáng tuyệt đối
        const m = prev && region ? shiftEstimate(prev, gray, region) : 99;
        prev = gray;
        const t = Date.now();
        if (!region) regionSince = 0;
        else if (!regionSince) regionSince = t;
        const sh = region ? sharpness(gray, region) : 0;
        sharpWin.push(sh);
        if (sharpWin.length > 10) sharpWin.shift();
        steady = region && m < 0.6 ? steady + 1 : 0;
        const display = region ? toDisplayBox(region, f, video, wrap) : null;
        const sharpEnough = sh > 0 && sh >= 0.8 * Math.max(...sharpWin);
        // Đứng yên đủ 2 khung & nét → chụp. Tay không giữ được yên (hoặc màn hình nhấp nháy khi chụp trực tiếp):
        // vùng chữ đã thấy ≥ 0,5 giây thì vẫn chụp khung nét nhất gần đây — không bao giờ treo ở "Giữ yên máy".
        const waitedLong = regionSince > 0 && t - Math.max(regionSince, lastShot) > 500;
        const crop = !reading && region && sharpEnough && (steady >= 2 || waitedLong) ? cropForOcr(video, region, f, focus) : null;
        // Khung nhòe (không đo được nét chữ) → bỏ, không tốn một lượt đọc chữ (tối đa 4 khung liền, phòng đo sai)
        const blurred = crop !== null && crop.ink === 0 && blurSkips < 4;
        if (blurred) blurSkips++;
        if (crop && !blurred) {
          blurSkips = 0;
          lastShot = t;
          reading = true;
          setScan((sc) => ({
            ...sc,
            phase: "reading",
            box: display,
            flash: Date.now(),
          }));
          onScreenCapture(crop.canvas)
            .then((r) => {
              const lastMs = Date.now() - t;
              // dải chờ xác nhận (tỉ lệ của ảnh vừa đọc) → quy về tỉ lệ của vùng chữ đầy đủ
              const b = crop.band;
              focus = r.focus ? { y0: b.y0 + r.focus.y0 * (b.y1 - b.y0), y1: b.y0 + r.focus.y1 * (b.y1 - b.y0) } : undefined;
              const gotNew = hasNew(r.newly);
              if (r.accepted.serial) quietAfter = gotNew ? 0 : quietAfter + 1;
              const complete = r.ok && isDeviceComplete(r.accepted, quietAfter, r.pending.length);
              if (complete) {
                // ĐỦ THÔNG TIN → DỪNG HẲN: không đọc lại nữa cho tới khi bấm "Máy tiếp theo"
                stopped = true;
                haptic("success");
              }
              setScan((sc) => ({
                ...sc,
                phase: complete ? "complete" : r.accepted.serial || r.accepted.imeis.length ? (gotNew ? "done" : "searching") : "searching",
                pending: r.pending,
                accepted: r.accepted,
                lastMs,
              }));
              if (gotNew || complete) setLastReadAt(Date.now());
            })
            .catch(() => {
              focus = undefined;
            })
            .finally(() => {
              reading = false;
              steady = 0;
            });
        } else if (!reading && !blurred) {
          setScan((sc) => ({
            ...sc,
            box: display,
            phase: sc.phase === "done" && Date.now() - sc.flash < 1500 ? "done" : !region ? "searching" : steady >= 1 ? "steady" : "moving",
          }));
        }
      }
      setNow(Date.now());
      if (!stopped) timer = window.setTimeout(tick, 80);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [state, target, onScreenCapture, round]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: !torch } as MediaTrackConstraintSet],
      });
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
      await track.applyConstraints({
        advanced: [{ zoom: next } as MediaTrackConstraintSet],
      });
      setZoom({ ...zoom, value: next });
    } catch {
      setZoom(null);
    }
  };

  const stuck = state === "running" && now - lastReadAt > (target === "screen" ? 9000 : 5000);

  return (
    <section className="sc-panel">
      {onScreenCapture && (
        <div className="sc-seg" role="radiogroup" aria-label="Quét cái gì">
          <button role="radio" aria-checked={target === "box"} className={target === "box" ? "is-active" : ""} onClick={() => setTarget("box")}>
            Sau hộp <span>mã vạch</span>
          </button>
          <button
            role="radio"
            aria-checked={target === "screen"}
            className={target === "screen" ? "is-active" : ""}
            onClick={() => {
              setTarget("screen");
              setScan({
                phase: "searching",
                box: null,
                pending: [],
                accepted: { imeis: [] },
                flash: 0,
              });
            }}
          >
            Màn hình máy <span>IMEI, Serial</span>
          </button>
        </div>
      )}
      <div ref={wrapRef} className={`sc-video-wrap ${state === "running" ? "is-running" : ""}`}>
        <video ref={videoRef} className="sc-video" playsInline muted autoPlay />
        {state === "running" && target === "box" && <div className={`sc-reticle ${now - lastReadAt < 800 ? "is-hit" : ""}`} aria-hidden />}
        {state === "running" && target === "screen" && scan.box && (
          <div
            className={`sc-docbox is-${scan.phase}`}
            style={{
              left: scan.box.x,
              top: scan.box.y,
              width: scan.box.w,
              height: scan.box.h,
            }}
            aria-hidden
          />
        )}
        {state === "running" && target === "screen" && now - scan.flash < 180 && <div className="sc-shutter" aria-hidden />}
        {state === "running" && target === "screen" && scan.phase === "complete" && (
          <div className="sc-complete" role="status">
            <strong>✓ Đã đọc xong máy này</strong>
            <span>Camera đã dừng đọc — không ghi thêm gì cho tới khi anh chọn máy tiếp theo.</span>
            <button className="sc-btn sc-btn-primary" onClick={nextDevice}>
              Quét máy tiếp theo
            </button>
          </div>
        )}
        {state === "running" && (
          <span className="sc-live-pill" data-testid="scan-status">
            ● {target === "screen" ? PHASE_LABEL[scan.phase] : "Đang tự quét mã vạch"}
            {resolution ? ` · ${resolution}` : ""}
            {target === "screen" && scan.lastMs ? ` · đọc ${(scan.lastMs / 1000).toFixed(1).replace(".", ",")} s` : ""}
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
            <button className="sc-btn sc-btn-primary" onClick={nextDevice}>
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
      {target === "screen" && state === "running" && (scan.accepted.serial || scan.accepted.imeis.length > 0 || scan.pending.length > 0) && (
        <div className="sc-readout" aria-live="polite">
          {scan.accepted.serial && <span className="sc-chip is-ok">✓ Serial {scan.accepted.serial}</span>}
          {scan.accepted.imeis.map((i, k) => (
            <span key={i} className="sc-chip is-ok">
              ✓ IMEI{k ? " 2" : ""} {i}
            </span>
          ))}
          {scan.accepted.partNumber && <span className="sc-chip is-ok">✓ {scan.accepted.partNumber}</span>}
          {scan.pending.map((p) => (
            <span key={p} className="sc-chip">
              {p} · chờ đọc lần 2
            </span>
          ))}
        </div>
      )}
      {target === "screen" ? (
        <p className={`sc-hint ${stuck ? "sc-hint-warn" : ""}`}>
          {stuck ? (
            <>
              Chưa đọc được. Mở <b>Cài đặt › Cài đặt chung › Giới thiệu</b> trên máy cần quét, để màn hình đủ sáng, giữ thẳng và tránh loá; lùi ra 20–30 cm để
              thấy cả dòng IMEI / Số sê-ri.
            </>
          ) : (
            <>
              Hướng camera vào màn hình <b>Giới thiệu</b> của máy cần quét. Khung vàng tự bám theo vùng chữ; <b>giữ yên khoảng nửa giây</b> là tự chụp và đọc —
              mỗi giá trị phải đọc khớp 2 lần mới nhận, đọc xong máy sẽ <b>rung + bíp</b>. Cuộn màn hình máy để đọc thêm IMEI.
            </>
          )}
        </p>
      ) : stuck ? (
        <p className="sc-hint sc-hint-warn">
          Chưa đọc được mã nào. Lùi máy ra <b>20–30 cm</b> (camera iPhone Pro không lấy nét quá gần)
          {zoom ? (
            <>
              , bấm <b>Phóng to 2×</b>
            </>
          ) : null}
          , bật đèn nếu tối, hoặc bấm <b>📸 Chụp &amp; đọc kỹ</b> để đọc cả chữ trên nhãn.
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
        Chọn ảnh là <b>tự đọc ngay</b>: mã vạch trên nhãn hộp
        {hasOcr ? (
          <>
            , và chữ trên ảnh chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b> (IMEI, Số sê-ri, Số kiểu máy)
          </>
        ) : null}
        . Ảnh không rời khỏi máy của bạn.
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
      <p className="sc-hint">Có máy quét mã vạch USB/Bluetooth? Cứ quét khi đang ở trang này (không cần bấm vào ô nào) — mã sẽ tự vào đúng ô.</p>
    </section>
  );
}

type ScanPhase = "searching" | "moving" | "steady" | "reading" | "done" | "complete";

interface ScreenScanState {
  phase: ScanPhase;
  box: { x: number; y: number; w: number; h: number } | null;
  pending: string[];
  accepted: Accepted;
  flash: number;
  /** thời gian (ms) của lần cắt + đọc chữ gần nhất — hiện trên khung để biết máy đọc nhanh hay chậm */
  lastMs?: number;
}

const PHASE_LABEL: Record<ScanPhase, string> = {
  searching: "Đang tìm vùng chữ…",
  moving: "Giữ yên máy…",
  steady: "Giữ yên… sắp chụp",
  reading: "Đang đọc chữ…",
  done: "✓ Đã đọc",
  complete: "✓ Xong máy này — đã dừng đọc",
};

/** Hộp trên khung hình nhỏ (phân tích) → toạ độ hiển thị trên thẻ video (object-fit: cover). */
function toDisplayBox(r: TextRegion, f: number, video: HTMLVideoElement, wrap: HTMLElement) {
  const cw = wrap.clientWidth;
  const ch = wrap.clientHeight;
  const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
  const ox = (cw - video.videoWidth * scale) / 2;
  const oy = (ch - video.videoHeight * scale) / 2;
  return {
    x: ox + r.x * f * scale,
    y: oy + r.y * f * scale,
    w: r.w * f * scale,
    h: r.h * f * scale,
  };
}

/**
 * Cắt vùng chữ ở ĐỘ PHÂN GIẢI GỐC của camera và phóng to để mỗi dòng chữ cao ~56 px
 * (cỡ chữ Tesseract đọc tốt nhất). Đây là khác biệt lớn nhất so với đọc cả khung hình.
 */
/** Dải dọc của vùng chữ, tính theo tỉ lệ 0–1 chiều cao vùng cắt đầy đủ. */
type Band = { y0: number; y1: number };

/**
 * Cắt vùng chữ từ khung video và đưa về cỡ chữ bộ đọc cần. Có `band` → chỉ cắt dải đó (± đệm), dùng cho lần
 * đọc xác nhận Serial/Part No. — trả kèm dải thực đã cắt.
 */
function cropForOcr(video: HTMLVideoElement, r: TextRegion, f: number, band?: Band): { canvas: HTMLCanvasElement; ink: number; band: Band } {
  const margin = Math.max(r.lineHeight, 8);
  const sx = Math.max(0, (r.x - margin) * f);
  const fy = Math.max(0, (r.y - margin) * f);
  const fh = Math.min(video.videoHeight - fy, (r.h + 2 * margin) * f);
  let sy = fy;
  let sh = fh;
  if (band) {
    const pad = Math.max(r.lineHeight * f, (band.y1 - band.y0) * fh * 0.35);
    sy = Math.max(fy, fy + band.y0 * fh - pad);
    sh = Math.min(fy + fh, fy + band.y1 * fh + pad) - sy;
  }
  const used: Band = { y0: (sy - fy) / fh, y1: (sy + sh - fy) / fh };
  const sw = Math.min(video.videoWidth - sx, (r.w + 2 * margin) * f);
  // 1) đo chiều cao nét chữ trên bản thu nhỏ (≤ 900 px) của vùng cắt — đủ chính xác, khỏi đọc cả vùng 4K gốc
  const s0 = Math.min(1, 900 / Math.max(sw, sh));
  const probe = document.createElement("canvas");
  probe.width = Math.max(1, Math.round(sw * s0));
  probe.height = Math.max(1, Math.round(sh * s0));
  const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  pctx.drawImage(video, sx, sy, sw, sh, 0, 0, probe.width, probe.height);
  const inkSmall = inkLineHeight(toGray(pctx.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height));
  const ink = inkSmall / s0; // px của khung gốc
  // 2) đưa chữ về ~INK_TARGET_PX — cỡ bộ đọc chữ đọc đúng mà nhanh nhất (đã đo: chữ 11–26 px đọc đúng, 7 px đọc
  //    sai; camera 4K cho chữ 50–80 px → thu nhỏ, đọc nhanh gấp nhiều lần). Cắt + thu/phóng bằng MỘT lần vẽ từ video.
  let scale = ink > 0 ? Math.min(2.5, Math.max(0.3, INK_TARGET_PX / ink)) : Math.min(3, Math.max(1, 56 / Math.max(4, r.lineHeight * f)));
  scale = Math.min(scale, 2000 / Math.max(sw, sh));
  if (Math.abs(scale - s0) < 0.03) return { canvas: probe, ink, band: used };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { canvas, ink, band: used };
}

/** Chiều cao nét chữ mục tiêu khi đưa vào bộ đọc chữ (px). */
const INK_TARGET_PX = 13;

/** Ảnh tĩnh: tìm vùng chữ trên bản thu nhỏ rồi cắt ở độ phân giải gốc, phóng to (null nếu không thấy vùng chữ rõ). */
async function cropTextRegion(image: Blob): Promise<HTMLCanvasElement | null> {
  const bitmap = await createImageBitmap(image, {
    imageOrientation: "from-image",
  });
  try {
    const W = 480;
    const f = bitmap.width / W;
    const small = document.createElement("canvas");
    small.width = W;
    small.height = Math.max(1, Math.round(bitmap.height / f));
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, small.width, small.height);
    const region = findTextRegion(toGray(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height));
    // vùng chữ chiếm gần hết ảnh (ảnh chụp màn hình gốc) → không cần cắt
    if (!region || region.lineCount < 2 || region.w * region.h > 0.8 * small.width * small.height) return null;
    const margin = Math.max(region.lineHeight, 8);
    const sx = Math.max(0, (region.x - margin) * f);
    const sy = Math.max(0, (region.y - margin) * f);
    const sw = Math.min(bitmap.width - sx, (region.w + 2 * margin) * f);
    const sh = Math.min(bitmap.height - sy, (region.h + 2 * margin) * f);
    const scale = Math.min(3, Math.max(1, 56 / Math.max(4, region.lineHeight * f)), 2600 / Math.max(sw, sh));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const octx = out.getContext("2d")!;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  } finally {
    bitmap.close();
  }
}
