/**
 * Đọc chữ (OCR) trên trình duyệt bằng Tesseract.js — tự phục vụ mọi file (không CDN):
 *   <base>/worker.min.js, <base>/tesseract-core-*-lstm.wasm.js, <base>/eng.traineddata.gz
 * Tải lần đầu khi cần (~7 MB), sau đó trình duyệt lưu lại.
 */
import type { Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function absolute(base: string) {
  return new URL(base.endsWith("/") ? base : `${base}/`, window.location.href).href.replace(/\/$/, "");
}

export function getOcrWorker(base: string, onProgress?: (p: number) => void): Promise<Worker> {
  if (workerPromise) return workerPromise;
  const root = absolute(base);
  workerPromise = import("tesseract.js")
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
    })
    .catch((e) => {
      workerPromise = null;
      throw e;
    });
  return workerPromise;
}

/**
 * Chuẩn bị ảnh cho OCR: ảnh xám, đảo màu nếu nền tối (chế độ tối của iOS), phóng to ảnh nhỏ.
 * KHÔNG kéo giãn độ tương phản: đã đo — với ảnh chủ yếu là nền, kéo giãn làm chữ chìm vào nền
 * (ảnh chế độ tối không đọc được gì); Tesseract tự chọn ngưỡng sáng tối tốt hơn.
 */
async function prepare(image: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = longSide < 1200 ? 2 : longSide > 3000 ? 3000 / longSide : 1;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
      sum += g;
    }
    if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    ctx.putImageData(img, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Đọc toàn bộ chữ trên ảnh. Các lần gọi được xếp hàng (một worker). */
export function recognizeText(base: string, image: Blob, onProgress?: (p: number) => void): Promise<string> {
  const job = queue.then(async () => {
    const worker = await getOcrWorker(base, onProgress);
    const canvas = await prepare(image);
    const { data } = await worker.recognize(canvas);
    return data.text;
  });
  queue = job.catch(() => undefined);
  return job;
}
