/**
 * Đọc chữ (OCR) trên trình duyệt bằng Tesseract.js — tự phục vụ mọi file (không CDN):
 *   <base>/worker.min.js, <base>/tesseract-core-*-lstm.wasm.js, <base>/eng.traineddata.gz
 * Tải lần đầu khi cần (~7 MB), sau đó trình duyệt lưu lại.
 */
import type { Worker } from "tesseract.js";


declare global {
  interface Window {
    /** 5 lần đọc chữ gần nhất — để chẩn đoán khi đọc sai (xem trong công cụ nhà phát triển / kiểm thử). */
    __ipreOcrLog?: string[];
    /** thời gian (ms) và kích thước ảnh của các lần đọc chữ gần nhất — đo tốc độ */
    __ipreOcrTimes?: string[];
  }
}

function logTime(t0: number, c: { width: number; height: number }) {
  if (typeof window === "undefined") return;
  const log = (window.__ipreOcrTimes ??= []);
  log.push(`${Math.round(performance.now() - t0)}ms ${c.width}x${c.height}`);
  if (log.length > 20) log.shift();
}

function logOcr(text: string) {
  if (typeof window === "undefined") return;
  const log = (window.__ipreOcrLog ??= []);
  log.push(text);
  if (log.length > 5) log.shift();
}
function absolute(base: string) {
  return new URL(base.endsWith("/") ? base : `${base}/`, window.location.href).href.replace(/\/$/, "");
}

/**
 * Nhóm 2 bộ đọc chữ chạy SONG SONG: camera chụp 2 khung liên tiếp → đọc cùng lúc → Serial đủ 2 phiếu
 * sau MỘT lượt đọc thay vì hai lượt nối tiếp. Bộ thứ 2 chỉ khởi tạo khi cần (ảnh tải lên dùng 1 bộ).
 */
const POOL_SIZE = 2;
const pool: (Promise<Worker> | null)[] = Array(POOL_SIZE).fill(null);
const busy: boolean[] = Array(POOL_SIZE).fill(false);
const waiters: (() => void)[] = [];

function createOcrWorker(base: string, onProgress?: (p: number) => void): Promise<Worker> {
  const root = absolute(base);
  return import("tesseract.js")
    .then(({ createWorker }) =>
      createWorker("eng", 1, {
        workerPath: `${root}/worker.min.js`,
        corePath: root,
        langPath: root,
        gzip: true,
        logger: (m: { status: string; progress: number }) => {
          if (m.status.startsWith("loading") || m.status.startsWith("initializ")) onProgress?.(m.progress);
        },
      }),
    )
    .then(async (w) => {
      await w.setParameters({
        // PSM 6 (một khối văn bản): giữ nhãn và giá trị trên CÙNG một dòng ("Serial Number … F2LXQ7Y9KD"),
        // đã đo trên ảnh mẫu: đọc đúng hơn PSM 11/3, kể cả khung hình camera mờ, ám màu.
        tessedit_pageseg_mode: "6" as never,
        preserve_interword_spaces: "1",
      });
      return w;
    });
}

function slot(i: number, base: string, onProgress?: (p: number) => void): Promise<Worker> {
  const existing = pool[i];
  if (existing) return existing;
  const created = createOcrWorker(base, onProgress).catch((e) => {
    pool[i] = null;
    throw e;
  });
  pool[i] = created;
  return created;
}

export function getOcrWorker(base: string, onProgress?: (p: number) => void): Promise<Worker> {
  return slot(0, base, onProgress);
}

/** Khởi tạo sẵn bộ đọc chữ (tải ~7 MB lần đầu) ngay khi bật camera — lần chụp đầu khỏi phải chờ. */
export function warmOcr(base: string, workers = POOL_SIZE, onProgress?: (p: number) => void): Promise<unknown> {
  return Promise.all(Array.from({ length: Math.min(workers, POOL_SIZE) }, (_, i) => slot(i, base, i === 0 ? onProgress : undefined))).catch(() => undefined);
}

async function withWorker<T>(base: string, maxWorkers: number, onProgress: ((p: number) => void) | undefined, fn: (w: Worker) => Promise<T>): Promise<T> {
  for (;;) {
    const i = busy.findIndex((b, k) => !b && k < maxWorkers);
    if (i >= 0) {
      busy[i] = true;
      try {
        return await fn(await slot(i, base, onProgress));
      } finally {
        busy[i] = false;
        waiters.splice(0).forEach((wake) => wake());
      }
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

/** Ảnh xám + đảo màu nếu nền tối (chế độ tối của iOS) — xử lý tại chỗ trên canvas. */
function toOcrGray(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  ctx.putImageData(img, 0, 0);
}

/**
 * Chuẩn bị ảnh cho OCR: ảnh xám, đảo màu nếu nền tối, phóng to ảnh nhỏ.
 * KHÔNG kéo giãn độ tương phản: đã đo — với ảnh chủ yếu là nền, kéo giãn làm chữ chìm vào nền
 * (ảnh chế độ tối không đọc được gì); Tesseract tự chọn ngưỡng sáng tối tốt hơn.
 */
async function prepare(image: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = longSide < 1200 ? 2 : longSide > 3000 ? 3000 / longSide : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    toOcrGray(canvas);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Đọc chữ trên một canvas đã cắt sẵn vùng văn bản (camera, chế độ "Màn hình máy"). */
export function recognizeCanvas(base: string, canvas: HTMLCanvasElement, onProgress?: (p: number) => void): Promise<string> {
  return withWorker(base, POOL_SIZE, onProgress, async (worker) => {
    const t0 = performance.now();
    toOcrGray(canvas);
    const { data } = await worker.recognize(canvas);
    logTime(t0, canvas);
    logOcr(data.text);
    return data.text;
  });
}

/** Đọc toàn bộ chữ trên ảnh. Các lần gọi được xếp hàng (một bộ đọc). */
export function recognizeText(base: string, image: Blob, onProgress?: (p: number) => void): Promise<string> {
  return withWorker(base, 1, onProgress, async (worker) => {
    const canvas = await prepare(image);
    const { data } = await worker.recognize(canvas);
    logOcr(data.text);
    return data.text;
  });
}
