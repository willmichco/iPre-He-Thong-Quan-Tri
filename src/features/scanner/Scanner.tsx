"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
import {
  applyExtraction,
  emptyRecord,
  findMatch,
  mergeRecord,
  mergeLiveFrame,
  mergeStream,
  recordsFromPhoto,
  toCsv,
  toTsv,
  validateRecord,
  type DeviceRecord,
  type FieldSource,
  type PositionedCode,
  type StreamState,
} from "@/domain/scan-session";
import { splitPastedText } from "@/domain/identifiers";
import { extractFromText, hasIdentity, isComplete, mergeExtractions } from "@/domain/text-extract";
import { acceptedAsExtraction, addReading, emptyVotes, hasNew, type ScreenVotes } from "@/domain/screen-votes";
import { CameraPanel } from "./CameraPanel";
import { cropTextRegion } from "./crop";
import { decodePhoto, initDecoder, type WasmSource } from "./decoder";
import { haptic } from "./haptics";
import { Icon } from "./icons";
import { recognizeCanvas, recognizeSplit, recognizeText, warmOcr, type OcrLine } from "./ocr";
import { ManualPanel, PhotoPanel } from "./panels";
import { RecordCard } from "./RecordCard";
import type { ImageResult, ScreenReadResult } from "./types";
import "./scanner.css";

export type { ImageResult, ScreenReadResult } from "./types";

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
  /** Gửi phiên quét về máy chủ (hộp chờ duyệt). Bản độc lập không có → không hiện nút. */
  onSubmit?: (records: DeviceRecord[]) => Promise<{ ok: boolean; message: string }>;
  /** Báo danh sách máy đã quét mỗi khi phiên đổi (vd trang nhận kiện đối chiếu ngay). */
  onRecordsChange?: (records: DeviceRecord[]) => void;
  /** Nội dung thêm ở góc phải tiêu đề (vd liên kết Hộp chờ duyệt). */
  headerExtra?: ReactNode;
  /** Nhúng trong trang khác (vd Nhận kiện): tiêu đề nhỏ (h2), lề gọn. */
  embedded?: boolean;
}

const MODES: { mode: Mode; label: string; icon: "camera" | "image" | "keyboard" }[] = [
  { mode: "camera", label: "Camera", icon: "camera" },
  { mode: "photo", label: "Ảnh", icon: "image" },
  { mode: "manual", label: "Nhập tay / Dán", icon: "keyboard" },
];

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

/** So khớp lỏng giữa dòng OCR và giá trị đã chuẩn hoá (OCR hay lẫn O/0, I/1, bỏ khoảng trắng). */
function lineHas(line: string, value: string): boolean {
  const norm = (t: string) => t.toUpperCase().replace(/\s+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return norm(line).includes(norm(value));
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
  onSubmit,
  onRecordsChange,
  headerExtra,
  embedded = false,
}: ScannerProps) {
  // Component chỉ chạy phía trình duyệt (xem ScannerClient) nên đọc localStorage ngay được.
  const [session, setSession] = useState<StreamState>(() => loadSession(storageKey));
  const sessionRef = useRef<StreamState>(session);
  const [mode, setMode] = useState<Mode>(liveCamera ? "camera" : "photo");
  const [confirmClear, setConfirmClear] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [decoderState, setDecoderState] = useState<"loading" | "ready" | "error">("loading");
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const ocrTried = useRef<Set<string>>(new Set());
  /** Phiếu bầu của các lần chụp màn hình máy (chế độ "Màn hình máy") cho máy đang quét. */
  const votesRef = useRef<ScreenVotes>(emptyVotes());

  // Lưu phiên xuống thiết bị: gom các thay đổi dồn dập (camera đọc nhiều mã liên tiếp) thành một lần ghi
  // sau 250 ms — JSON.stringify cả phiên ở mỗi mã là việc thừa trên luồng chính. Rời trang thì ghi ngay.
  const persistTimer = useRef(0);
  const save = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessionRef.current));
    } catch {
      /* bỏ qua: chỉ là tiện ích lưu tạm trên thiết bị */
    }
  }, [storageKey]);
  const flush = useCallback(() => {
    if (!persistTimer.current) return;
    window.clearTimeout(persistTimer.current);
    persistTimer.current = 0;
    save();
  }, [save]);
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  /** Mọi thay đổi phiên đi qua đây để ref (dùng trong vòng quét) luôn khớp state. */
  const update = useCallback(
    (fn: (s: StreamState) => StreamState) => {
      sessionRef.current = fn(sessionRef.current);
      setSession(sessionRef.current);
      window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = 0;
        save();
      }, 250);
    },
    [save],
  );

  useEffect(() => {
    initDecoder(wasm).then(
      () => setDecoderState("ready"),
      () => setDecoderState("error"),
    );
  }, [wasm]);

  const toastTimer = useRef(0);
  const notify = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

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

  const onCapture = useCallback(
    async (blob: Blob) => {
      const r = await processImage(blob, `camera-${new Date().toLocaleTimeString("vi-VN")}.jpg`);
      notify(
        r.added || r.updated
          ? `Đã đọc: ${r.added} máy mới, ${r.updated} máy bổ sung${r.usedOcr ? " (có đọc chữ)" : ""}`
          : "Vẫn chưa đọc được — thử lùi xa hơn, bật đèn, hoặc nhập tay",
      );
    },
    [notify, processImage],
  );
  const toManual = useCallback(() => setMode("manual"), []);
  const toPhoto = useCallback(() => setMode("photo"), []);

  const records = session.records;
  useEffect(() => onRecordsChange?.(records), [records, onRecordsChange]);
  const issuesById = useMemo(() => Object.fromEntries(records.map((r) => [r.id, validateRecord(r, records, expectedRegion)])), [records, expectedRegion]);
  const errorCount = Object.values(issuesById).reduce((n, list) => n + list.filter((i) => i.severity === "error").length, 0);

  // ổn định tham chiếu → thẻ máy (memo) không vẽ lại khi máy khác thay đổi
  const updateRecord = useCallback(
    (id: string, fn: (r: DeviceRecord) => DeviceRecord) =>
      update((s) => ({
        ...s,
        records: s.records.map((r) => (r.id === id ? fn(r) : r)),
      })),
    [update],
  );
  const removeRecord = useCallback(
    (id: string) =>
      update((s) => ({
        records: s.records.filter((r) => r.id !== id),
        currentId: s.currentId === id ? null : s.currentId,
      })),
    [update],
  );

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

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!onSubmit || sending) return;
    setSending(true);
    try {
      const r = await onSubmit(records);
      notify(r.message);
      if (r.ok) haptic("success");
    } catch {
      notify("Chưa gửi được — kiểm tra mạng rồi thử lại (phiên quét vẫn giữ trên máy)");
    } finally {
      setSending(false);
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
  const Title = embedded ? "h2" : "h1";

  return (
    <div className={`sc-root ${embedded ? "is-embedded" : ""}`}>
      <header className="sc-head">
        <div className="sc-head-text">
          <Title className="sc-title">Quét mã máy</Title>
          <p className="sc-sub">
            IMEI · Serial · Part No. — {records.length} máy
            {errorCount > 0 && <span className="sc-err-count"> · {errorCount} lỗi cần sửa</span>}
          </p>
        </div>
        <div className="sc-head-aside">
          {headerExtra}
          <span className={`sc-engine is-${decoderState}`}>
            <span className="sc-engine-dot" aria-hidden />
            {decoderState === "loading" ? "Đang tải bộ giải mã…" : decoderState === "ready" ? "Sẵn sàng" : "Lỗi bộ giải mã"}
          </span>
        </div>
      </header>

      <div className="sc-layout">
        <div className="sc-tools">
          <div className="sc-tabs" role="tablist" aria-label="Cách nhập">
            {MODES.map((m) => (
              <button key={m.mode} type="button" role="tab" aria-selected={mode === m.mode} className={`sc-tab ${mode === m.mode ? "is-active" : ""}`} onClick={() => setMode(m.mode)}>
                <Icon name={m.icon} size={19} />
                <span>{m.label}</span>
              </button>
            ))}
          </div>

          {mode === "camera" && !liveCamera && (
            <section className="sc-panel sc-nolive">
              <span className="sc-drop-icon" aria-hidden>
                <Icon name="camera" size={26} />
              </span>
              <p>Trang xem thử này không được phép mở camera trực tiếp.</p>
              <p className="sc-muted">
                Dùng tab <b>Ảnh</b> → <b>Chụp ảnh</b>: iPhone mở camera để chụp nhãn hộp, kết quả giống hệt.
              </p>
              <button type="button" className="sc-btn sc-btn-primary" onClick={toPhoto}>
                <Icon name="image" size={18} />
                Chuyển sang chụp ảnh
              </button>
            </section>
          )}
          {mode === "camera" && liveCamera && (
            <CameraPanel
              ready={ready}
              busy={busy !== null}
              onCodes={onLiveCodes}
              onScreenCapture={ocrBase ? onScreenCapture : undefined}
              onWarmOcr={onWarmOcr}
              onCapture={onCapture}
              onNextDevice={nextDevice}
              onManual={toManual}
              onSwitchToPhoto={toPhoto}
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
        </div>

        <div className="sc-results">
          {records.length > 0 && (
            <div className="sc-session" role="group" aria-label="Phiên quét">
              <p className="sc-session-info">
                <strong>{records.length}</strong> máy trong phiên
              </p>
              {confirmClear ? (
                <span className="sc-confirm">
                  Xoá {records.length} máy?
                  <button type="button" className="sc-btn sc-btn-danger" onClick={clearAll}>
                    Xoá hết
                  </button>
                  <button type="button" className="sc-btn sc-btn-ghost" onClick={() => setConfirmClear(false)}>
                    Giữ lại
                  </button>
                </span>
              ) : (
                <span className="sc-session-tools">
                  <button type="button" className="sc-btn sc-btn-icon" aria-label="Sao chép bảng" title="Sao chép bảng (dán vào Excel)" onClick={copyTable}>
                    <Icon name="copy" size={18} />
                    <span className="sc-btn-label">Sao chép bảng</span>
                  </button>
                  <button type="button" className="sc-btn sc-btn-icon" aria-label="Tải CSV" title="Tải CSV" onClick={exportCsv}>
                    <Icon name="download" size={18} />
                    <span className="sc-btn-label">Tải CSV</span>
                  </button>
                  <button type="button" className="sc-btn sc-btn-icon sc-btn-ghost" aria-label="Xoá phiên" title="Xoá phiên" onClick={() => setConfirmClear(true)}>
                    <Icon name="trash" size={18} />
                    <span className="sc-btn-label">Xoá phiên</span>
                  </button>
                </span>
              )}
              {onSubmit && (
                <button type="button" className="sc-btn sc-btn-primary sc-session-send" disabled={sending} onClick={submit}>
                  {sending ? <span className="sc-spinner" aria-hidden /> : <Icon name="send" size={18} />}
                  {sending ? "Đang gửi…" : `Gửi vào hộp chờ duyệt (${records.length})`}
                </button>
              )}
            </div>
          )}

          {copyFallback !== null && (
            <section className="sc-panel" aria-label="Sao chép thủ công">
              <p>Chọn toàn bộ nội dung dưới đây, sao chép rồi dán vào Excel:</p>
              <textarea className="sc-input sc-textarea" rows={6} readOnly data-paste-ignore="1" value={copyFallback} onFocus={(e) => e.currentTarget.select()} />
              <div className="sc-row">
                <button type="button" className="sc-btn" onClick={() => setCopyFallback(null)}>
                  Đóng
                </button>
              </div>
            </section>
          )}

          <section className="sc-list" aria-label="Danh sách máy đã quét">
            {records.length === 0 ? (
              <div className="sc-empty">
                <span className="sc-empty-icon" aria-hidden>
                  <Icon name="barcode" size={28} />
                </span>
                <strong>Chưa có máy nào</strong>
                <span>
                  Quét nhãn sau hộp máy, chụp ảnh hộp, dán ảnh chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b>, hoặc nhập tay.
                </span>
              </div>
            ) : (
              records
                .map((r, i) => (
                  <RecordCard
                    key={r.id}
                    record={r}
                    index={i + 1}
                    issues={issuesById[r.id] ?? []}
                    current={r.id === session.currentId}
                    thumb={thumbs[r.id]}
                    onUpdate={updateRecord}
                    onRemove={removeRecord}
                    renderPartNumberInfo={renderPartNumberInfo}
                  />
                ))
                .reverse()
            )}
          </section>
        </div>
      </div>

      {toast && (
        <div key={toast.id} className="sc-toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
