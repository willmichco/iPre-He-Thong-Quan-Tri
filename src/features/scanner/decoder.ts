/**
 * Bộ giải mã mã vạch chạy trên trình duyệt (zxing-wasm, WebAssembly).
 * - Ứng dụng Next.js / GitHub Pages: tải file .wasm tự phục vụ.
 * - Bản chạy thử một file: .wasm nhúng sẵn trong trang.
 */
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { PositionedCode } from "@/domain/scan-session";
import { LIVE_OPTIONS, PHOTO_OPTIONS, RETICLE } from "./reader-options";

export type WasmSource = { url: string } | { binary: ArrayBuffer };

let ready: Promise<unknown> | null = null;

export function initDecoder(source: WasmSource): Promise<unknown> {
  if (ready) return ready;
  const overrides =
    "binary" in source
      ? { wasmBinary: source.binary }
      : { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? source.url : prefix + path) };
  ready = prepareZXingModule({ overrides, fireImmediately: true });
  return ready;
}

function toPositioned(results: Awaited<ReturnType<typeof readBarcodes>>, scale = 1, offsetX = 0, offsetY = 0): PositionedCode[] {
  return results
    .filter((r) => r.isValid && r.text)
    .map((r) => {
      const p = r.position;
      const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
      const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
      return {
        text: r.text,
        x: offsetX + (xs.reduce((a, b) => a + b, 0) / 4) * scale,
        y: offsetY + (ys.reduce((a, b) => a + b, 0) / 4) * scale,
      };
    });
}

interface Region {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Vẽ một vùng của ảnh nguồn ra ImageData, chỉ thu nhỏ khi cạnh dài vượt maxSide. */
function regionToImageData(source: CanvasImageSource, region: Region, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(region.sw, region.sh));
  const cw = Math.max(1, Math.round(region.sw * scale));
  const ch = Math.max(1, Math.round(region.sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, region.sx, region.sy, region.sw, region.sh, 0, 0, cw, ch);
  return { data: ctx.getImageData(0, 0, cw, ch), scale, canvas };
}

export interface PhotoDecodeResult {
  codes: PositionedCode[];
  width: number;
  height: number;
  /** Ảnh nhỏ để hiển thị cạnh kết quả (data URL JPEG). */
  thumbnail: string;
}

/** Đọc mọi mã vạch trên một ảnh. Thử ở 2.400 px, nếu không thấy thì thử độ phân giải gốc (tối đa 4.000 px). */
export async function decodePhoto(file: Blob): Promise<PhotoDecodeResult> {
  if (!ready) throw new Error("Bộ giải mã chưa được khởi tạo");
  await ready;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const all = { sx: 0, sy: 0, sw: width, sh: height };
    const first = regionToImageData(bitmap, all, 2400);
    let codes = toPositioned(await readBarcodes(first.data, PHOTO_OPTIONS), 1 / first.scale);
    if (codes.length === 0 && first.scale < 1) {
      const full = regionToImageData(bitmap, all, 4000);
      codes = toPositioned(await readBarcodes(full.data, PHOTO_OPTIONS), 1 / full.scale);
    }
    const thumb = regionToImageData(bitmap, all, 240);
    return { codes, width, height, thumbnail: thumb.canvas.toDataURL("image/jpeg", 0.7) };
  } finally {
    bitmap.close();
  }
}

let frameCounter = 0;

/**
 * Canvas dùng lại cho quét trực tiếp — một cái cho toàn khung, một cái cho vùng khung ngắm. Trước đây mỗi khung
 * hình tạo canvas mới (~13 MB ở 2.400 px), ~6 lần/giây: bộ nhớ rác liên tục, bộ dọn rác chạy là giật hình trên
 * điện thoại. Giờ chỉ cấp phát lại khi kích thước đổi (xoay máy, đổi camera).
 */
const liveCanvases: Record<"full" | "reticle", { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null> = { full: null, reticle: null };

function liveImageData(video: HTMLVideoElement, kind: "full" | "reticle", region: Region, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(region.sw, region.sh));
  const cw = Math.max(1, Math.round(region.sw * scale));
  const ch = Math.max(1, Math.round(region.sh * scale));
  let slot = liveCanvases[kind];
  if (!slot) {
    const canvas = document.createElement("canvas");
    slot = liveCanvases[kind] = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
  }
  if (slot.canvas.width !== cw || slot.canvas.height !== ch) {
    slot.canvas.width = cw;
    slot.canvas.height = ch;
  }
  slot.ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, cw, ch);
  return { data: slot.ctx.getImageData(0, 0, cw, ch), scale };
}

/**
 * Đọc một khung hình camera. Mặc định giải mã vùng khung ngắm ở ĐỘ PHÂN GIẢI GỐC
 * (mã trên nhãn Apple rất mảnh, thu nhỏ là mất), xen kẽ với toàn khung hình (nhãn lệch khỏi khung ngắm).
 */
export async function decodeVideoFrame(video: HTMLVideoElement): Promise<PositionedCode[]> {
  if (!ready || video.readyState < 2 || video.videoWidth === 0) return [];
  await ready;
  const W = video.videoWidth;
  const H = video.videoHeight;
  frameCounter++;
  const full = frameCounter % 2 === 0;
  const region = full
    ? { sx: 0, sy: 0, sw: W, sh: H }
    : { sx: Math.round(W * RETICLE.x), sy: Math.round(H * RETICLE.y), sw: Math.round(W * RETICLE.w), sh: Math.round(H * RETICLE.h) };
  const { data, scale } = liveImageData(video, full ? "full" : "reticle", region, 2400);
  return toPositioned(await readBarcodes(data, LIVE_OPTIONS), 1 / scale, region.sx, region.sy);
}

/** Chụp khung hình hiện tại ở độ phân giải gốc (nút "Chụp & đọc kỹ", OCR tự động). */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  const { canvas } = regionToImageData(video, { sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight }, 4000);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không chụp được khung hình"))), "image/jpeg", 0.92),
  );
}

/** Vẽ một ảnh (kể cả SVG/data URL) ra PNG rồi đọc như ảnh chụp — dùng cho nút "Thử với nhãn mẫu". */
export async function rasterizeImageUrl(url: string, scale = 2): Promise<Blob> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const w = Math.round((img.naturalWidth || 600) * scale);
  const h = Math.round((img.naturalHeight || 900) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không tạo được ảnh"))), "image/png"),
  );
}
