/**
 * Trợ lý — câu trả lời có cấu trúc, trung lập kênh: web vẽ thành thẻ + nút; kênh chỉ có chữ (Telegram, Zalo sau này)
 * dùng `text` và đánh số các nút (người dùng gõ "1", "ok", "huỷ"…). Tiền là chuỗi đã định dạng.
 */

export type AssistantEvent =
  | { type: "CONFIRM"; actionId: string }
  | { type: "DISCARD"; actionId: string }
  | { type: "TO_BANG_KE"; actionId: string }
  | { type: "EDIT"; actionId: string; text: string }
  /** chọn một lựa chọn bot đưa ra (máy, khách, tài khoản, đơn…) */
  | { type: "CHOOSE"; actionId: string; index: number };

export interface Chip {
  label: string;
  /** gửi như người dùng gõ */
  text?: string;
  /** sự kiện gắn với phiếu */
  event?: AssistantEvent;
}

export type ActionStatus = "PENDING" | "CONFIRMED" | "DISCARDED" | "FAILED" | "EXPIRED" | "DRAFTED";

export interface PreviewCard {
  kind: "preview";
  actionId: string;
  title: string;
  rows: [label: string, value: string][];
  /** lãi dự kiến (đơn bán) */
  profit?: { value: string; margin: string | null; negative: boolean; provisional: boolean };
  warnings: string[];
  /** điều kiện chặn: chưa bấm Xác nhận được */
  blockers: string[];
  status: ActionStatus;
  result?: { href: string; label: string };
  error?: string;
}
export interface TableCard {
  kind: "table";
  title?: string;
  columns: string[];
  /** cột căn phải (số) */
  numeric?: number[];
  rows: string[][];
  hrefs?: (string | null)[];
  /** còn bao nhiêu dòng không hiện */
  more?: number;
  footer?: string[];
}
export interface StatCard {
  kind: "stat";
  title?: string;
  items: { label: string; value: string; hint?: string; tone?: "good" | "bad" | "warn" }[];
}
export type Card = PreviewCard | TableCard | StatCard;

export interface Reply {
  text: string;
  cards?: Card[];
  chips?: Chip[];
  link?: { href: string; label: string; download?: boolean };
}

/** Dạng chữ của một câu trả lời (cho kênh không vẽ được thẻ). */
export function replyAsText(r: Reply): string {
  const out = [r.text];
  for (const c of r.cards ?? []) {
    if (c.kind === "preview") {
      out.push(`— ${c.title} —`, ...c.rows.map(([k, v]) => `${k}: ${v}`));
      if (c.profit) out.push(`Lãi dự kiến: ${c.profit.value}${c.profit.margin ? ` (${c.profit.margin})` : ""}`);
      out.push(...c.warnings.map((w) => `⚠ ${w}`), ...c.blockers.map((w) => `⛔ ${w}`));
      if (c.status === "PENDING" && !c.blockers.length) out.push('Gõ "ok" để ghi, "sửa …" để sửa, "huỷ" để bỏ.');
    } else if (c.kind === "stat") out.push(...c.items.map((i) => `${i.label}: ${i.value}`));
    else {
      if (c.title) out.push(c.title);
      out.push(...c.rows.map((row) => row.join(" · ")));
      if (c.more) out.push(`… và ${c.more} dòng nữa`);
    }
  }
  (r.chips ?? []).forEach((ch, i) => out.push(`${i + 1}. ${ch.label}`));
  if (r.link) out.push(`${r.link.label}: ${r.link.href}`);
  return out.join("\n");
}
