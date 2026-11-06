import { useCallback, useEffect, useRef, useState } from "react";
import type { PositionedCode } from "@/domain/scan-session";
import { hasNew, isDeviceComplete, type Accepted } from "@/domain/screen-votes";
import { cropForOcr, toDisplayBox, type Band, type Box } from "./crop";
import { captureVideoFrame, decodeVideoFrame } from "./decoder";
import { findTextRegion, sharpness, shiftEstimate, toGray, type Gray } from "./frame-analysis";
import { haptic, unlockFeedback } from "./haptics";
import { Icon } from "./icons";
import { Tip } from "./panels";
import type { ScreenReadResult } from "./types";

type ZoomCaps = { min: number; max: number; step?: number };
type CameraTarget = "box" | "screen";
type ScanPhase = "searching" | "moving" | "steady" | "reading" | "done" | "complete";

const PHASE_LABEL: Record<ScanPhase, string> = {
  searching: "Đang tìm vùng chữ…",
  moving: "Giữ yên máy…",
  steady: "Giữ yên… sắp chụp",
  reading: "Đang đọc chữ…",
  done: "Đã đọc",
  complete: "Xong máy này — đã dừng đọc",
};
const PHASE_TONE: Record<ScanPhase, "idle" | "warn" | "busy" | "ok"> = {
  searching: "idle",
  moving: "warn",
  steady: "warn",
  reading: "busy",
  done: "ok",
  complete: "ok",
};

interface Readout {
  pending: string[];
  accepted: Accepted;
  /** thời gian (ms) của lần cắt + đọc chữ gần nhất — hiện trên khung để biết máy đọc nhanh hay chậm */
  lastMs?: number;
}
const EMPTY_READOUT: Readout = { pending: [], accepted: { imeis: [] } };

/** Sau bao lâu không đọc được gì thì hiện mẹo xử lý (ms). */
const STUCK_MS: Record<CameraTarget, number> = { box: 5000, screen: 9000 };

export function CameraPanel({
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [zoom, setZoom] = useState<{ caps: ZoomCaps; value: number } | null>(null);
  const [resolution, setResolution] = useState("");
  const [target, setTarget] = useState<CameraTarget>("box");
  /** tăng mỗi lần bấm "Máy tiếp theo" → khởi động lại vòng đọc màn hình (sau khi đã tự dừng) */
  const [round, setRound] = useState(0);
  const [lastSeen, setLastSeen] = useState<string[]>([]);
  const [hit, setHit] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [phase, setPhaseState] = useState<ScanPhase>("searching");
  const [readout, setReadout] = useState<Readout>(EMPTY_READOUT);
  /** tăng mỗi lần tự chụp → vẽ lại lớp chớp sáng (hiệu ứng CSS chạy một lần khi gắn vào) */
  const [flashKey, setFlashKey] = useState(0);

  // Các giá trị đổi liên tục trong vòng quét nằm ở ref — KHÔNG đổi state mỗi khung hình (trước đây bộ quét vẽ lại
  // 7–12 lần/giây chỉ để cập nhật đồng hồ). Giờ chỉ vẽ lại khi có sự kiện thật: đọc được mã, đổi giai đoạn.
  const phaseRef = useRef<ScanPhase>("searching");
  const lastReadRef = useRef(0);
  /** khung camera còn trong tầm nhìn? Cuộn xuống sửa thẻ máy → tạm ngừng giải mã, gõ phím / cuộn không bị giật */
  const visibleRef = useRef(true);
  const hitTimer = useRef(0);
  const setPhase = useCallback((p: ScanPhase) => {
    if (phaseRef.current === p) return;
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const markRead = useCallback(() => {
    lastReadRef.current = Date.now();
    setStuck(false);
  }, []);
  const resetScreen = useCallback(() => {
    phaseRef.current = "searching";
    setPhaseState("searching");
    setReadout(EMPTY_READOUT);
    markRead();
  }, [markRead]);

  const nextDevice = () => {
    onNextDevice();
    resetScreen();
    setRound((r) => r + 1);
  };

  const chooseTarget = (t: CameraTarget) => {
    setTarget(t);
    resetScreen();
  };

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
    setTorch(null);
    setZoom(null);
  }, []);

  useEffect(() => stop, [stop]);
  useEffect(() => () => window.clearTimeout(hitTimer.current), []);

  useEffect(() => {
    if (target === "screen") onWarmOcr?.(); // gọi lại nhiều lần cũng không sao: bộ đọc chỉ tạo một lần
  }, [target, onWarmOcr]);

  // "Chưa đọc được" sau một lúc: kiểm tra mỗi giây; setState cùng giá trị thì React bỏ qua, không vẽ lại.
  useEffect(() => {
    if (state !== "running") return;
    const limit = STUCK_MS[target];
    const id = window.setInterval(() => setStuck(Date.now() - lastReadRef.current > limit), 1000);
    return () => window.clearInterval(id);
  }, [state, target]);

  useEffect(() => {
    const el = wrapRef.current;
    if (state !== "running" || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => {
        visibleRef.current = e.isIntersecting && e.intersectionRatio >= 0.25;
        if (visibleRef.current) lastReadRef.current = Math.max(lastReadRef.current, Date.now() - 1000); // vừa quay lại: chưa tính là "kẹt"
      },
      { threshold: [0, 0.25] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      visibleRef.current = true;
    };
  }, [state]);

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
      markRead();
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
      // trang bị ẩn (chuyển ứng dụng, khoá màn hình) hoặc khung camera bị cuộn khuất → không giải mã, đỡ tốn pin
      if (video && !document.hidden && visibleRef.current) {
        try {
          const codes = await decodeVideoFrame(video);
          if (!stopped && codes.length) {
            const texts = codes.map((c) => c.text);
            setLastSeen((prev) => (prev.length === texts.length && prev.every((t, i) => t === texts[i]) ? prev : texts));
            markRead();
            setHit(true);
            window.clearTimeout(hitTimer.current);
            hitTimer.current = window.setTimeout(() => setHit(false), 800);
            onCodes(codes, grab);
          }
        } catch {
          /* khung hình lỗi — bỏ qua */
        }
      }
      if (!stopped) timer = window.setTimeout(tick, 150);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [state, ready, target, onCodes, grab, markRead]);

  // Chế độ "Màn hình máy" — luồng kiểu app quét tài liệu:
  // tìm vùng chữ → chờ đứng yên & đủ nét → tự chụp vùng đó ở độ phân giải gốc → đọc chữ → bỏ phiếu.
  // Khung bám vùng chữ được đặt thẳng vào DOM (transform) mỗi khung — không qua state React.
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
    let doneAt = 0;
    let blurSkips = 0;
    let focus: Band | undefined; // các dòng còn chờ xác nhận — lần đọc sau chỉ đọc dải này
    const sharpWin: number[] = [];
    const small = document.createElement("canvas");
    const ctx = small.getContext("2d", { willReadFrequently: true })!;

    const placeBox = (b: Box | null) => {
      const el = boxRef.current;
      if (!el) return;
      if (!b) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      el.style.transform = `translate3d(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px, 0)`;
      el.style.width = `${b.w.toFixed(1)}px`;
      el.style.height = `${b.h.toFixed(1)}px`;
    };

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const wrap = wrapRef.current;
      if (video && wrap && video.videoWidth && !document.hidden && visibleRef.current) {
        const W = 480;
        const f = video.videoWidth / W;
        const h = Math.round(video.videoHeight / f);
        if (small.width !== W || small.height !== h) {
          small.width = W;
          small.height = h;
        }
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
          placeBox(display);
          setPhase("reading");
          setFlashKey((k) => k + 1);
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
              const some = Boolean(r.accepted.serial || r.accepted.imeis.length);
              if (gotNew) doneAt = Date.now();
              setPhase(complete ? "complete" : some && gotNew ? "done" : "searching");
              setReadout({ pending: r.pending, accepted: r.accepted, lastMs });
              if (gotNew || complete) markRead();
            })
            .catch(() => {
              focus = undefined;
            })
            .finally(() => {
              reading = false;
              steady = 0;
            });
        } else if (!reading && !blurred) {
          placeBox(display);
          setPhase(phaseRef.current === "done" && Date.now() - doneAt < 1500 ? "done" : !region ? "searching" : steady >= 1 ? "steady" : "moving");
        }
      }
      if (!stopped) timer = window.setTimeout(tick, 80);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [state, target, onScreenCapture, round, setPhase, markRead]);

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

  const running = state === "running";
  const screen = target === "screen";
  const complete = running && screen && phase === "complete";
  const tone = screen ? PHASE_TONE[phase] : hit ? "ok" : "live";
  const showStuck = running && stuck && !complete;

  return (
    <section className="sc-panel sc-camera">
      {onScreenCapture && (
        <div className="sc-seg" role="radiogroup" aria-label="Quét cái gì">
          <button type="button" role="radio" aria-checked={!screen} className={!screen ? "is-active" : ""} onClick={() => chooseTarget("box")}>
            <span className="sc-seg-icon" aria-hidden>
              <Icon name="barcode" size={20} />
            </span>
            <span className="sc-seg-text">
              Sau hộp <span>mã vạch</span>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={screen} className={screen ? "is-active" : ""} onClick={() => chooseTarget("screen")}>
            <span className="sc-seg-icon" aria-hidden>
              <Icon name="phone" size={20} />
            </span>
            <span className="sc-seg-text">
              Màn hình máy <span>IMEI, Serial</span>
            </span>
          </button>
        </div>
      )}

      <div ref={wrapRef} className={`sc-vf is-${target} ${running ? "is-running" : ""}`}>
        <video ref={videoRef} className="sc-video" playsInline muted autoPlay />

        {running && !screen && (
          <div className={`sc-reticle ${hit ? "is-hit" : ""}`} aria-hidden>
            <i className="sc-corner sc-tl" />
            <i className="sc-corner sc-tr" />
            <i className="sc-corner sc-bl" />
            <i className="sc-corner sc-br" />
            <i className="sc-laser" />
            {hit && lastSeen.length > 0 && (
              <span className="sc-hit">
                <Icon name="check" size={15} />
                Đọc được {lastSeen.length} mã
              </span>
            )}
          </div>
        )}
        {running && screen && <div ref={boxRef} className={`sc-docbox is-${phase}`} aria-hidden />}
        {running && screen && flashKey > 0 && <div key={flashKey} className="sc-shutter" aria-hidden />}

        {running && (
          <div className="sc-hud-top">
            <span className={`sc-status is-${tone}`} data-testid="scan-status">
              <span className="sc-status-dot" aria-hidden />
              <span>{screen ? PHASE_LABEL[phase] : "Đang tự quét mã vạch"}</span>
              {screen && readout.lastMs ? <span className="sc-status-meta">đọc {(readout.lastMs / 1000).toFixed(1).replace(".", ",")} s</span> : null}
            </span>
            {resolution && <span className="sc-res">{resolution}</span>}
          </div>
        )}

        {running && !complete && (
          <div className="sc-hud-bottom">
            <div className="sc-hud-side">
              {torch !== null && (
                <button type="button" className={`sc-fab ${torch ? "is-on" : ""}`} aria-label={torch ? "Tắt đèn" : "Bật đèn"} aria-pressed={torch} onClick={toggleTorch}>
                  <Icon name="torch" size={20} />
                </button>
              )}
              {zoom && (
                <button type="button" className="sc-fab sc-fab-text" aria-label={zoom.value > 1 ? "Thu về 1×" : "Phóng to 2×"} onClick={toggleZoom}>
                  {zoom.value > 1 ? "2×" : "1×"}
                </button>
              )}
            </div>
            <button type="button" className="sc-shoot" disabled={busy} onClick={async () => onCapture(await grab())}>
              <span className="sc-shoot-ring" aria-hidden />
              <span className="sc-shoot-label">Chụp &amp; đọc kỹ</span>
            </button>
            <div className="sc-hud-side is-end">
              <button type="button" className="sc-fab" aria-label="Tắt camera" title="Tắt camera" onClick={stop}>
                <Icon name="close" size={20} />
              </button>
            </div>
          </div>
        )}

        {complete && (
          <div className="sc-complete" role="status">
            <div className="sc-complete-card">
              <span className="sc-complete-icon" aria-hidden>
                <Icon name="check" size={30} />
              </span>
              <strong>Đã đọc xong máy này</strong>
              <span>Camera đã dừng đọc — không ghi thêm gì cho tới khi chọn máy tiếp theo.</span>
              <button type="button" className="sc-btn sc-btn-primary" onClick={nextDevice}>
                Quét máy tiếp theo
                <Icon name="next" size={18} />
              </button>
            </div>
          </div>
        )}

        {!running && (
          <div className="sc-idle">
            <div className="sc-idle-art" aria-hidden>
              {screen ? <ScreenArt /> : <BoxArt />}
            </div>
            {state === "error" ? (
              <>
                <p className="sc-idle-title">{error}</p>
                <p className="sc-idle-sub">
                  Dùng tab <b>Ảnh</b> → <b>Chụp ảnh</b>: iPhone sẽ mở camera để chụp nhãn hộp.
                </p>
                <button type="button" className="sc-btn sc-btn-lg" onClick={onSwitchToPhoto}>
                  <Icon name="image" size={18} />
                  Chuyển sang chụp ảnh
                </button>
              </>
            ) : (
              <>
                <p className="sc-idle-title">{screen ? "Quét màn hình Giới thiệu" : "Quét nhãn sau hộp máy"}</p>
                <p className="sc-idle-sub">
                  {screen ? (
                    <>Tự tìm vùng chữ, tự chụp khi máy đứng yên, đọc IMEI · Serial · Part No.</>
                  ) : (
                    <>Tự đọc mọi mã vạch trong khung — Serial, IMEI, Part No., UPC. Không cần bấm.</>
                  )}
                </p>
                <button type="button" className="sc-btn sc-btn-primary sc-btn-lg" disabled={state === "starting"} onClick={start}>
                  {state === "starting" ? <span className="sc-spinner" aria-hidden /> : <Icon name="camera" size={20} />}
                  {state === "starting" ? "Đang mở camera…" : "Bật camera quét"}
                </button>
                <p className="sc-idle-foot">Hình ảnh chỉ xử lý trên máy này, không gửi đi đâu.</p>
              </>
            )}
          </div>
        )}
      </div>

      {running && (
        <div className="sc-row sc-cam-actions">
          <button type="button" className="sc-btn sc-btn-primary" onClick={nextDevice}>
            <Icon name="next" size={18} />
            Máy tiếp theo
          </button>
          <button type="button" className="sc-btn" onClick={onManual}>
            <Icon name="keyboard" size={18} />
            Nhập tay
          </button>
        </div>
      )}

      {running && !screen && lastSeen.length > 0 && (
        <div className="sc-readout" aria-live="polite">
          <span className="sc-readout-label">Vừa thấy</span>
          {lastSeen.slice(0, 6).map((c) => (
            <span key={c} className="sc-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      {running && screen && (readout.accepted.serial || readout.accepted.imeis.length > 0 || readout.pending.length > 0) && (
        <div className="sc-readout" aria-live="polite">
          {readout.accepted.serial && <span className="sc-chip is-ok">✓ Serial {readout.accepted.serial}</span>}
          {readout.accepted.imeis.map((i, k) => (
            <span key={i} className="sc-chip is-ok">
              ✓ IMEI{k ? " 2" : ""} {i}
            </span>
          ))}
          {readout.accepted.partNumber && <span className="sc-chip is-ok">✓ {readout.accepted.partNumber}</span>}
          {readout.pending.map((p) => (
            <span key={p} className="sc-chip is-pending">
              {p} · chờ đọc lần 2
            </span>
          ))}
        </div>
      )}

      {screen ? (
        <Tip tone={showStuck ? "warn" : "info"}>
          {showStuck ? (
            <>
              Chưa đọc được. Mở <b>Cài đặt › Cài đặt chung › Giới thiệu</b> trên máy cần quét, để màn hình đủ sáng, giữ thẳng và tránh loá; lùi ra 20–30 cm để
              thấy cả dòng IMEI / Số sê-ri.
            </>
          ) : (
            <>
              Hướng camera vào màn hình <b>Giới thiệu</b> của máy cần quét. Khung tự bám theo vùng chữ; <b>giữ yên khoảng nửa giây</b> là tự chụp và đọc — mỗi
              giá trị phải đọc khớp 2 lần mới nhận, đọc xong máy sẽ <b>rung + bíp</b>. Cuộn màn hình máy để đọc thêm IMEI.
            </>
          )}
        </Tip>
      ) : showStuck ? (
        <Tip tone="warn">
          Chưa đọc được mã nào. Lùi máy ra <b>20–30 cm</b> (camera iPhone Pro không lấy nét quá gần)
          {zoom ? (
            <>
              , bấm nút <b>1×</b> để phóng to 2×
            </>
          ) : null}
          , bật đèn nếu tối, hoặc bấm nút chụp <b>Chụp &amp; đọc kỹ</b> để đọc cả chữ trên nhãn.
        </Tip>
      ) : (
        <Tip>
          Đưa nhãn sau hộp vào khung — mã được đọc <b>tự động</b>, không cần bấm. Part No. chỉ in bằng chữ sẽ được tự đọc chữ sau khi bắt được mã vạch.
        </Tip>
      )}
    </section>
  );
}

/** Minh hoạ màn hình chờ — nhãn hộp có mã vạch trong khung quét. */
function BoxArt() {
  return (
    <svg viewBox="0 0 160 120" fill="none">
      <rect x="34" y="22" width="92" height="76" rx="8" fill="currentColor" opacity="0.1" stroke="currentColor" strokeOpacity="0.35" />
      {[0, 1, 2].map((r) => (
        <g key={r} transform={`translate(44 ${34 + r * 20})`}>
          <rect width="34" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
          {[0, 3, 5, 9, 11, 14, 18, 20, 23, 27, 29, 33, 36, 38, 42, 45, 47, 51, 54, 57, 60, 62, 66, 69].map((x, i) => (
            <rect key={x} x={x} y="6" width={i % 3 === 0 ? 2 : 1.2} height="8" fill="currentColor" opacity="0.85" />
          ))}
        </g>
      ))}
      <path d="M22 30v-8a8 8 0 0 1 8-8h8M122 14h8a8 8 0 0 1 8 8v8M138 90v8a8 8 0 0 1-8 8h-8M38 106h-8a8 8 0 0 1-8-8v-8" stroke="#5aa9ff" strokeWidth="3.5" strokeLinecap="round" />
      <rect className="sc-art-laser" x="26" y="58" width="108" height="2.5" rx="1.25" fill="#5aa9ff" />
    </svg>
  );
}

/** Minh hoạ màn hình chờ — màn hình Giới thiệu của iPhone. */
function ScreenArt() {
  return (
    <svg viewBox="0 0 160 120" fill="none">
      <rect x="55" y="8" width="50" height="104" rx="10" fill="currentColor" opacity="0.1" stroke="currentColor" strokeOpacity="0.4" strokeWidth="2" />
      <rect x="72" y="13" width="16" height="4" rx="2" fill="currentColor" opacity="0.4" />
      {[0, 1, 2, 3, 4].map((r) => (
        <g key={r} transform={`translate(62 ${30 + r * 14})`}>
          <rect width="14" height="3" rx="1.5" fill="currentColor" opacity="0.55" />
          <rect x={20} width="16" height="3" rx="1.5" fill="currentColor" opacity={r === 2 || r === 4 ? 0.95 : 0.35} />
        </g>
      ))}
      <rect x="58" y="54" width="44" height="46" rx="6" stroke="#4fd07f" strokeWidth="2.5" strokeDasharray="0" />
    </svg>
  );
}
