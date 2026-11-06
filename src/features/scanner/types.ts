import type { Accepted } from "@/domain/screen-votes";

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

export interface ImageResult {
  barcodes: number;
  usedOcr: boolean;
  added: number;
  updated: number;
}
