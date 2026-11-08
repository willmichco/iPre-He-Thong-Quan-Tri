/**
 * Trợ lý — chuẩn hoá chữ tiếng Việt và tách từ. Hàm thuần, dùng chung trình duyệt + máy chủ.
 * `fold` bỏ dấu, đổi đ → d, viết thường: "Chị Lan" → "chi lan". Mọi so khớp từ khoá đều chạy trên chữ đã fold;
 * chữ gốc (giữ dấu, hoa thường) vẫn được giữ trong từng token để lấy tên khách, ghi chú.
 */

/** Bỏ dấu, đ → d, viết thường. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

export interface Token {
  /** chữ gốc (đã bỏ dấu câu ở hai đầu) */
  raw: string;
  /** chữ đã fold */
  f: string;
  /** vị trí trong chuỗi gốc */
  start: number;
}

/**
 * Tách từ theo khoảng trắng và ; | ! ? ( ) " — giữ nguyên số có dấu phân cách ("25,5tr", "25.500.000", "5/11", "BH-2026-0012").
 * Dấu , . : ở cuối / đầu từ bị bỏ ("hôm qua," → "hôm qua").
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[^\s;|!?()[\]{}"“”'‘’<>]+/g;
  for (const m of text.matchAll(re)) {
    let raw = m[0];
    let start = m.index;
    const lead = /^[,.:+*~=_#-]+/.exec(raw)?.[0].length ?? 0;
    // giữ dấu "+" của số điện thoại +84 và "$" của tiền đô
    const keepPlus = raw.startsWith("+") && /^\+\d/.test(raw);
    if (lead && !keepPlus) {
      raw = raw.slice(lead);
      start += lead;
    }
    raw = raw.replace(/[,.:;*~=_-]+$/, "");
    if (!raw) continue;
    out.push({ raw, f: fold(raw), start });
  }
  return out;
}

/** Viết hoa chữ đầu mỗi từ: "chị lan" → "Chị Lan". */
export const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase("vi") + w.slice(1))
    .join(" ");

/** Câu có dấu hiệu là câu hỏi (không dùng "mấy" vì fold ra "may" trùng "máy"). */
export function isQuestion(text: string): boolean {
  const f = ` ${fold(text).replace(/[^a-z0-9?]+/g, " ")} `
    // cụm có "chưa / không" nhưng là nội dung ghi, không phải câu hỏi
    .replace(/ (chua (tra|thanh toan|tt|lay|giao)|khong (bao hanh|bh)|ko (bao hanh|bh)) /g, " ");
  return (
    text.includes("?") ||
    / (bao nhieu|nao|ai|chua|khong|ko|gi|sao|o dau|the nao|ra sao|hay chua|duoc khong) /.test(f) ||
    /^ (co|liet ke|xem|cho xem|cho minh xem|kiem tra|tra|tra cuu|hoi) /.test(f)
  );
}
