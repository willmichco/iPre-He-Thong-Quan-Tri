/**
 * Trợ lý — lời đáp ngắn trong hội thoại nhiều lượt: xác nhận, huỷ, để sau (vào bảng kê nháp), sửa, chọn số.
 * Kênh chỉ có chữ (Telegram, Zalo sau này) dùng đúng các từ này thay cho nút bấm.
 */
import { fold } from "./normalize";

export type Meta =
  | { type: "CONFIRM" }
  | { type: "CANCEL" }
  | { type: "DRAFT" }
  | { type: "EDIT"; text: string }
  | { type: "CHOOSE"; index: number }
  | { type: "CLEAR" };

const clean = (s: string) =>
  fold(s)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const CONFIRM = new Set(
  [
    "ok",
    "oke",
    "okay",
    "okie",
    "ok nhe",
    "ok luon",
    "ok ghi",
    "ok ghi di",
    "xac nhan",
    "dong y",
    "chot",
    "chot luon",
    "chot di",
    "dung roi",
    "dung",
    "dung vay",
    "yes",
    "y",
    "ghi",
    "ghi di",
    "ghi luon",
    "luu",
    "luu di",
    "luu luon",
    "uh",
    "uk",
    "um",
    "u",
    "duoc",
    "dc",
    "chuan",
    "chinh xac",
    "xong",
    "ok xac nhan",
    "xac nhan ghi",
  ].map(clean),
);
const CANCEL = new Set(["huy", "huy bo", "huy di", "thoi", "thoi bo", "bo", "bo qua", "bo di", "khong", "ko", "no", "sai", "sai roi", "dung lai", "stop", "cancel"].map(clean));
const DRAFT = new Set(["de sau", "ghi nhap", "luu nhap", "vao bang ke", "dua vao bang ke", "bang ke nhap", "nhap tam", "tinh sau", "luu tam", "ghi tam", "cho vao bang ke"].map(clean));
const CLEAR = new Set(["xoa lich su", "xoa tro chuyen", "xoa het", "lam moi", "bat dau lai"].map(clean));

/** Nhận ra lời đáp ngắn. `pending` = đang có phiếu chờ xác nhận / câu hỏi chờ trả lời. */
export function metaOf(text: string, pending: boolean): Meta | null {
  const c = clean(text);
  if (!c) return null;
  if (CLEAR.has(c)) return { type: "CLEAR" };
  if (!pending) return null;
  if (CONFIRM.has(c)) return { type: "CONFIRM" };
  if (CANCEL.has(c)) return { type: "CANCEL" };
  if (DRAFT.has(c)) return { type: "DRAFT" };
  const choose = /^(?:chon |so |cai |may |lua chon )?(\d)$/.exec(c);
  if (choose) return { type: "CHOOSE", index: +choose[1] };
  const edit = /^(sua|doi|thay|chinh|cap nhat|chinh lai|sua lai|doi lai)\s+(.+)$/.exec(c);
  if (edit) {
    // giữ chữ gốc (có dấu) của phần sau động từ
    const words = text.trim().split(/\s+/);
    const verbLen = edit[1].split(" ").length;
    let rest = words.slice(verbLen).join(" ");
    // "sửa giá thành 26tr" / "đổi khách là chị Hoa"
    rest = rest.replace(/^(\S+)\s+(thành|thanh|là|la)\s+/i, "$1 ");
    return { type: "EDIT", text: rest };
  }
  return null;
}
