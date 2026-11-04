/** Lỗi nghiệp vụ của bộ máy tính giá vốn — có mã rõ ràng và thông điệp tiếng Việt (tài liệu 04, mục 10). */
export type CostingErrorCode =
  | "INVALID_NUMBER"
  | "EMPTY_WEIGHTS"
  | "NEGATIVE_WEIGHT"
  | "ZERO_WEIGHT"
  | "UNKNOWN_PURCHASE_ORDER"
  | "UNKNOWN_SHIPMENT"
  | "UNKNOWN_ITEM"
  | "NO_TARGET_ITEMS"
  | "MISSING_WEIGHT"
  | "MANUAL_SHARES_MISMATCH"
  | "MANUAL_SHARE_OUTSIDE_TARGET";

export class CostingError extends Error {
  constructor(
    readonly code: CostingErrorCode,
    message: string,
    /** id các đối tượng liên quan (máy thiếu cân nặng, chi phí lỗi…) để giao diện chỉ đúng chỗ cần sửa */
    readonly refs: string[] = [],
  ) {
    super(message);
    this.name = "CostingError";
  }
}
