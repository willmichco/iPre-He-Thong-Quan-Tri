/**
 * Cắt vùng chữ cho bộ đọc chữ (OCR) và quy đổi toạ độ khung phân tích → khung hiển thị.
 * Tách khỏi component để bộ quét chỉ còn phần giao diện; logic giữ nguyên.
 */
import { findTextRegion, inkLineHeight, toGray, type TextRegion } from "./frame-analysis";

/** Dải dọc của vùng chữ, tính theo tỉ lệ 0–1 chiều cao vùng cắt đầy đủ. */
export type Band = { y0: number; y1: number };

export type Box = { x: number; y: number; w: number; h: number };

/** Chiều cao nét chữ mục tiêu khi đưa vào bộ đọc chữ (px). */
const INK_TARGET_PX = 13;

/** Hộp trên khung hình nhỏ (phân tích) → toạ độ hiển thị trên thẻ video (object-fit: cover). */
export function toDisplayBox(r: TextRegion, f: number, video: HTMLVideoElement, wrap: HTMLElement): Box {
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
 * Cắt vùng chữ ở ĐỘ PHÂN GIẢI GỐC của camera rồi đưa về cỡ chữ bộ đọc cần — khác biệt lớn nhất so với đọc
 * cả khung hình. Có `band` → chỉ cắt dải đó (± đệm), dùng cho lần đọc xác nhận Serial/Part No. — trả kèm dải
 * thực đã cắt.
 */
export function cropForOcr(video: HTMLVideoElement, r: TextRegion, f: number, band?: Band): { canvas: HTMLCanvasElement; ink: number; band: Band } {
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

/** Ảnh tĩnh: tìm vùng chữ trên bản thu nhỏ rồi cắt ở độ phân giải gốc, phóng to (null nếu không thấy vùng chữ rõ). */
export async function cropTextRegion(image: Blob): Promise<HTMLCanvasElement | null> {
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
