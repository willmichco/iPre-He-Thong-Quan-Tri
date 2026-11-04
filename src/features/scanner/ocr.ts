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
 * Hai loại bộ đọc chữ:
 *  - "camera" (2 bộ, chạy SONG SONG): dữ liệu bản fast, không tự đọc lại dòng đảo màu → nhanh. Camera chụp 2 khung
 *    liên tiếp và đọc cùng lúc → Serial đủ 2 phiếu sau MỘT lượt đọc.
 *  - "photo" (1 bộ): dữ liệu bản best_int, mặc định của Tesseract → ảnh tải lên/dán vào đọc đúng nhất.
 */
export type OcrKind = "camera" | "photo";
/** Số bộ đọc của camera = số dải chữ đọc song song mỗi lần. */
const CAMERA_WORKERS = 2; // đã đo: 4 bộ song song tranh nhau CPU, mỗi dải còn chậm hơn — không nhanh hơn 2 bộ
const SLOTS: Record<OcrKind, number[]> = {
  camera: Array.from({ length: CAMERA_WORKERS }, (_, i) => i),
  photo: [CAMERA_WORKERS],
};
const pool: (Promise<Worker> | null)[] = Array(CAMERA_WORKERS + 1).fill(null);
const busy: boolean[] = Array(CAMERA_WORKERS + 1).fill(false);
/** bộ đọc của camera không khởi tạo được (thiếu bộ nhớ…) → bỏ qua, chia ít dải hơn */
const broken = new Set<number>();
const waiters: (() => void)[] = [];

function createOcrWorker(base: string, kind: OcrKind, onProgress?: (p: number) => void): Promise<Worker> {
  const root = absolute(base);
  const fast = kind === "camera";
  return import("tesseract.js")
    .then(({ createWorker }) =>
      createWorker("eng", 1, {
        workerPath: `${root}/worker.min.js`,
        corePath: root,
        langPath: fast ? `${root}/fast` : root,
        // khoá bộ nhớ đệm riêng cho từng bộ dữ liệu (cùng tên "eng")
        cachePath: fast ? "ipre-ocr-fast" : "ipre-ocr-best",
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
        // Camera: không để Tesseract tự đọc lại dòng kém tự tin ở dạng đảo màu (nhân đôi thời gian ở dòng khó);
        // ảnh nền tối đã được đảo sẵn ở toOcrGray().
        ...(fast ? { tessedit_do_invert: "0" } : {}),
      } as never);
      return w;
    });
}

function slot(i: number, base: string, onProgress?: (p: number) => void): Promise<Worker> {
  const existing = pool[i];
  if (existing) return existing;
  const created = createOcrWorker(base, SLOTS.camera.includes(i) ? "camera" : "photo", onProgress).catch((e) => {
    pool[i] = null;
    if (i > 0 && SLOTS.camera.includes(i)) broken.add(i);
    throw e;
  });
  pool[i] = created;
  return created;
}

export function getOcrWorker(base: string, onProgress?: (p: number) => void): Promise<Worker> {
  return slot(SLOTS.photo[0], base, onProgress);
}

/** Khởi tạo sẵn các bộ đọc chữ của camera khi chọn "Màn hình máy" — lần chụp đầu khỏi phải chờ. */
export function warmOcr(base: string, onProgress?: (p: number) => void): Promise<unknown> {
  return Promise.all(
    SLOTS.camera.map((i, k) => {
      const fresh = !pool[i];
      const w = slot(i, base, k === 0 ? onProgress : undefined);
      // Lần đọc ĐẦU TIÊN của một bộ đọc chậm gấp 2–3 lần (khởi động mạng nơ-ron) → đọc nháp một ảnh nhỏ ngay
      // lúc khởi tạo, để lần chụp thật đầu tiên đã ở tốc độ bình thường.
      return fresh ? w.then((wk) => wk.recognize(warmupImage())) : w;
    }),
  ).catch(() => undefined);
}

function warmupImage(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 48;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#000";
  ctx.font = "20px sans-serif";
  ctx.fillText("Serial F2LXQ7Y9KD 3500", 8, 32);
  return c;
}

async function withWorker<T>(base: string, kind: OcrKind, onProgress: ((p: number) => void) | undefined, fn: (w: Worker) => Promise<T>): Promise<T> {
  for (;;) {
    const i = SLOTS[kind].find((k) => !busy[k] && !broken.has(k));
    if (i !== undefined) {
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

/** Một dòng chữ đọc được và vị trí dọc của nó (px của ảnh đưa vào). */
export interface OcrLine {
  text: string;
  y0: number;
  y1: number;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
}

async function recognizeOn(worker: Worker, canvas: HTMLCanvasElement, withLines: boolean): Promise<OcrResult> {
  const t0 = performance.now();
  toOcrGray(canvas);
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: withLines });
  logTime(t0, canvas);
  logOcr(data.text);
  const lines: OcrLine[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) lines.push({ text: l.text, y0: l.bbox.y0, y1: l.bbox.y1 });
  return { text: data.text, lines };
}

/** Đọc chữ trên một canvas đã cắt sẵn vùng văn bản (mặc định: bộ đọc của camera, chế độ "Màn hình máy"). */
export function recognizeCanvas(base: string, canvas: HTMLCanvasElement, onProgress?: (p: number) => void, kind: OcrKind = "camera"): Promise<string> {
  return withWorker(base, kind, onProgress, async (worker) => (await recognizeOn(worker, canvas, false)).text);
}

/**
 * Camera: chia vùng chữ thành tối đa N DẢI (N = số bộ đọc của camera) tại các hàng trống — khe giữa hai dòng,
 * không cắt ngang chữ — rồi đọc các dải SONG SONG. Vùng thấp (vd. chỉ 2 dòng cần xác nhận) thì đọc nguyên.
 * Trả kèm vị trí từng dòng (px của `canvas`) để lần sau chỉ cần đọc lại đúng các dòng cần thiết.
 */
export async function recognizeSplit(base: string, canvas: HTMLCanvasElement, onProgress?: (p: number) => void): Promise<OcrResult> {
  const usable = SLOTS.camera.filter((k) => !broken.has(k)).length;
  const cuts = splitRows(canvas, usable);
  const edges = [0, ...cuts, canvas.height];
  const parts = edges.slice(0, -1).map((y0, k) => {
    const y1 = edges[k + 1];
    if (!cuts.length) return { y0, c: canvas };
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = y1 - y0;
    c.getContext("2d")!.drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, canvas.width, y1 - y0);
    return { y0, c };
  });
  const results = await Promise.all(parts.map(({ c }) => withWorker(base, "camera", onProgress, (w) => recognizeOn(w, c, true))));
  return {
    text: results.map((r) => r.text).join("\n"),
    lines: results.flatMap((r, k) => r.lines.map((l) => ({ text: l.text, y0: l.y0 + parts[k].y0, y1: l.y1 + parts[k].y0 }))),
  };
}

/**
 * Các hàng cắt (≤ n−1) chia ảnh thành n dải gần bằng nhau, mỗi hàng là hàng TRỐNG (chỉ còn vài cạnh của viền
 * khung/mép màn hình; dòng chữ có hàng chục cạnh) gần vị trí chia đều nhất. Dải phải cao ≥ 40 px.
 */
function splitRows(canvas: HTMLCanvasElement, n: number): number[] {
  const { width: w, height: h } = canvas;
  if (n < 2 || h < 80 || w < 40) return [];
  const parts = Math.max(2, Math.min(n, Math.floor(h / 40)));
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const edges = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let e = 0;
    const row = y * w * 4;
    for (let x = 0; x < w - 2; x += 2) e += Math.abs(d[row + x * 4 + 4] - d[row + x * 4]) > 24 ? 1 : 0;
    edges[y] = e;
  }
  const blank = Math.max(6, w * 0.01);
  const cuts: number[] = [];
  for (let k = 1; k < parts; k++) {
    const target = (h * k) / parts;
    const win = (h / parts) * 0.4;
    let best = -1;
    let bestScore = Infinity;
    for (let y = Math.max(1, Math.round(target - win)); y <= Math.min(h - 2, Math.round(target + win)); y++) {
      const score = edges[y] + Math.abs(y - target) / h;
      if (score < bestScore) {
        bestScore = score;
        best = y;
      }
    }
    if (best > 0 && bestScore < blank && best - (cuts[cuts.length - 1] ?? 0) >= 40 && h - best >= 40) cuts.push(best);
  }
  return cuts;
}

/** Đọc toàn bộ chữ trên ảnh. Các lần gọi được xếp hàng (một bộ đọc). */
export function recognizeText(base: string, image: Blob, onProgress?: (p: number) => void): Promise<string> {
  return withWorker(base, "photo", onProgress, async (worker) => {
    const canvas = await prepare(image);
    const { data } = await worker.recognize(canvas);
    logOcr(data.text);
    return data.text;
  });
}
