/**
 * Bộ giải mã mã vạch chạy trên trình duyệt (zxing-wasm, WebAssembly).
 * - Ứng dụng Next.js: tải file .wasm từ /wasm/zxing_reader.wasm (tự phục vụ, không phụ thuộc CDN).
 * - Bản chạy thử độc lập: file .wasm được nhúng sẵn trong trang.
 */
import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
import type { PositionedCode } from "@/domain/scan-session";

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

/** Các định dạng xuất hiện trên nhãn hộp Apple, màn hình *#06# và hoá đơn. */
const FORMATS: ReaderOptions["formats"] = ["Code128", "Code39", "EAN13", "UPCA", "QRCode", "DataMatrix"];

const PHOTO_OPTIONS: ReaderOptions = {
  formats: FORMATS,
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 16,
};

const LIVE_OPTIONS: ReaderOptions = {
  formats: FORMATS,
  tryHarder: false,
  tryRotate: true,
  tryInvert: false,
  maxNumberOfSymbols: 8,
};

function toPositioned(results: Awaited<ReturnType<typeof readBarcodes>>, scale = 1): PositionedCode[] {
  return results
    .filter((r) => r.isValid && r.text)
    .map((r) => {
      const p = r.position;
      const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
      const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
      return {
        text: r.text,
        x: (xs.reduce((a, b) => a + b, 0) / 4) * scale,
        y: (ys.reduce((a, b) => a + b, 0) / 4) * scale,
      };
    });
}

function drawToImageData(source: CanvasImageSource, w: number, h: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, cw, ch);
  return { data: ctx.getImageData(0, 0, cw, ch), scale };
}

export interface PhotoDecodeResult {
  codes: PositionedCode[];
  width: number;
  height: number;
  /** Ảnh nhỏ để hiển thị cạnh kết quả (data URL JPEG). */
  thumbnail: string;
}

/** Đọc mọi mã vạch trên một ảnh. Thử ở 2.000 px, nếu không thấy thì thử độ phân giải gốc. */
export async function decodePhoto(file: Blob): Promise<PhotoDecodeResult> {
  if (!ready) throw new Error("Bộ giải mã chưa được khởi tạo");
  await ready;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const first = drawToImageData(bitmap, width, height, 2000);
    let codes = toPositioned(await readBarcodes(first.data, PHOTO_OPTIONS), 1 / first.scale);
    if (codes.length === 0 && first.scale < 1) {
      const full = drawToImageData(bitmap, width, height, 4000);
      codes = toPositioned(await readBarcodes(full.data, PHOTO_OPTIONS), 1 / full.scale);
    }
    const thumbCanvas = document.createElement("canvas");
    const t = Math.min(1, 240 / Math.max(width, height));
    thumbCanvas.width = Math.round(width * t);
    thumbCanvas.height = Math.round(height * t);
    thumbCanvas.getContext("2d")!.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return { codes, width, height, thumbnail: thumbCanvas.toDataURL("image/jpeg", 0.7) };
  } finally {
    bitmap.close();
  }
}

/** Đọc một khung hình camera (ưu tiên tốc độ). */
export async function decodeVideoFrame(video: HTMLVideoElement): Promise<PositionedCode[]> {
  if (!ready || video.readyState < 2 || video.videoWidth === 0) return [];
  await ready;
  const { data, scale } = drawToImageData(video, video.videoWidth, video.videoHeight, 1280);
  return toPositioned(await readBarcodes(data, LIVE_OPTIONS), 1 / scale);
}

/** Vẽ một ảnh (kể cả SVG/data URL) ra PNG rồi đọc như ảnh chụp — dùng cho nút "Thử với nhãn mẫu". */
export async function decodeImageUrl(url: string, scale = 2): Promise<PhotoDecodeResult> {
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
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không tạo được ảnh"))), "image/png"),
  );
  return decodePhoto(blob);
}
