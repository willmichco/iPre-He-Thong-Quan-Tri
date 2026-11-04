/**
 * Tuỳ chọn giải mã zxing — tách riêng để kiểm thử được trên Node.
 *
 * Bài học từ hộp máy thật (11/2026): nhãn Apple có mã vạch Code 128 rất mảnh và dày.
 * Tắt `tryHarder` cho nhanh thì KHÔNG đọc được mã nào; bật lên chỉ tốn ~20 ms/khung hình.
 * Vì vậy cả quét trực tiếp lẫn ảnh đều luôn bật `tryHarder`.
 */
import type { ReaderOptions } from "zxing-wasm/reader";

/** Mã vạch trên nhãn hộp Apple, màn hình *#06#, hoá đơn. */
export const LINEAR_FORMATS: NonNullable<ReaderOptions["formats"]> = ["Code128", "EAN13", "UPCA", "Code39"];

export const PHOTO_OPTIONS: ReaderOptions = {
  formats: [...LINEAR_FORMATS, "QRCode", "DataMatrix"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 16,
};

/** Quét trực tiếp: chỉ mã 1D (nhanh hơn ~2 lần), nhưng vẫn đọc kỹ. */
export const LIVE_OPTIONS: ReaderOptions = {
  formats: LINEAR_FORMATS,
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: false,
  maxNumberOfSymbols: 10,
};

/** Vùng khung ngắm trên khung hình gốc (tỉ lệ) — giải mã vùng này ở độ phân giải gốc, không thu nhỏ. */
export const RETICLE = { x: 0.04, y: 0.22, w: 0.92, h: 0.56 };
