/**
 * Sắc độ huy hiệu trạng thái (.badge data-tone) — một bảng cho mọi trang để cùng một trạng thái luôn cùng một màu.
 * ok: xong / an toàn · info: đang diễn ra · warn: cần để ý · danger: sự cố · muted: chưa bắt đầu / đã kết thúc.
 */
export type Tone = "ok" | "info" | "warn" | "danger" | "muted" | "solid-danger";

export const SALE_TONE: Record<string, Tone> = { COMPLETED: "ok", DEPOSITED: "warn", CANCELLED: "muted" };

export const BATCH_TONE: Record<string, Tone> = {
  DRAFT: "muted",
  PURCHASING: "info",
  IN_TRANSIT: "info",
  ARRIVED: "info",
  COSTS_FINALIZED: "ok",
  CLOSED: "muted",
};

export const ITEM_TONE: Record<string, Tone> = {
  ORDERED: "muted",
  US_IN_TRANSIT: "info",
  AT_US_WAREHOUSE: "info",
  INTL_IN_TRANSIT: "info",
  AT_HN: "info",
  DOMESTIC_IN_TRANSIT: "info",
  IN_STOCK: "ok",
  RESERVED: "warn",
  SOLD: "muted",
  RETURNED_TO_SELLER: "muted",
  WARRANTY: "warn",
  LOST: "danger",
  DAMAGED: "danger",
  PERSONAL_USE: "muted",
};
