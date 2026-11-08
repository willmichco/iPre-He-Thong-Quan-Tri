/**
 * Trợ lý — đọc ngày và kỳ trong câu nhắn, theo giờ Việt Nam. `today` dạng "YYYY-MM-DD".
 * Ngày: hôm nay · hôm qua · hôm kia · thứ 2..7 / chủ nhật (+ tuần này / tuần trước) · 5/11 · 5/11/2026 · 05-11-2026 ·
 *       ngày 5 · 3 ngày trước.
 * Kỳ:   tuần này / trước · tháng này / trước · tháng 11 · tháng 11/2025 · quý này / trước · quý 3 · quý 3/2025 · năm nay /
 *       năm ngoái · năm 2025 · 7 ngày qua · từ 1/10 đến 15/10.
 * Ngày / tháng không ghi năm mà rơi vào tương lai → hiểu là năm trước (nhắn "bán ngày 28/12" vào tháng 1).
 */
import { addDays, quarterOf, type PresetKey } from "../reports";
import type { Token } from "./normalize";

export interface DayHit {
  kind: "day";
  date: string;
  start: number;
  len: number;
}
export interface PeriodHit {
  kind: "period";
  /** preset của trang Báo cáo, hoặc khoảng ngày (tính cả ngày cuối) */
  ky?: PresetKey;
  tu?: string;
  den?: string;
  start: number;
  len: number;
}
export type DateHit = DayHit | PeriodHit;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** thứ trong tuần theo kiểu Việt Nam: 2 = thứ Hai … 7 = thứ Bảy, 8 = Chủ nhật */
const vnWeekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = CN
  return w === 0 ? 8 : w + 1;
};
const mondayOf = (d: string) => addDays(d, -(vnWeekday(d) - 2));

const WEEKDAY: Record<string, number> = { hai: 2, ba: 3, tu: 4, nam: 5, sau: 6, bay: 7 };

/** "5/11" · "5/11/2026" · "05-11-26" · "5.11.2026" → ngày (năm thiếu: năm nay, tương lai thì năm trước) */
export function parseDayMonth(s: string, today: string, allowDot = false): string | null {
  const re = allowDot ? /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/ : /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/;
  const m = re.exec(s);
  if (!m) return null;
  const d = +m[1];
  const mo = +m[2];
  let y = m[3] ? +m[3] : +today.slice(0, 4);
  if (m[3] && m[3].length === 2) y += 2000;
  if (!valid(y, mo, d)) return null;
  let out = iso(y, mo, d);
  if (!m[3] && out > today) {
    if (!valid(y - 1, mo, d)) return null;
    out = iso(y - 1, mo, d);
  }
  return out;
}

/** "2026-11-05" (ISO) */
const isoDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && valid(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) ? s : null);

/** Đọc ngày / kỳ bắt đầu tại token i. */
export function dateAt(tokens: readonly Token[], i: number, today: string): DateHit | null {
  const f = (k: number) => tokens[i + k]?.f ?? "";
  const day = (date: string, len: number): DayHit => ({ kind: "day", date, start: i, len });
  const range = (tu: string, den: string, len: number): PeriodHit => ({ kind: "period", tu, den, start: i, len });
  const preset = (ky: PresetKey, len: number): PeriodHit => ({ kind: "period", ky, start: i, len });
  const y = +today.slice(0, 4);
  const mo = +today.slice(5, 7);
  const past = (w: string) => w === "truoc" || w === "roi" || w === "ngoai" || w === "vua roi" || w === "qua";

  // "từ 1/10 đến 15/10" · "từ 1/10 tới nay"
  if (f(0) === "tu") {
    const a = parseDayMonth(f(1), today) ?? isoDay(f(1));
    if (a && (f(2) === "den" || f(2) === "toi" || f(2) === "-")) {
      if (f(3) === "nay" || (f(3) === "hom" && f(4) === "nay")) return range(a, today, f(3) === "nay" ? 4 : 5);
      const b = parseDayMonth(f(3), today) ?? isoDay(f(3));
      if (b) return range(a, b, 4);
    }
  }
  // "hôm nay" · "hôm qua" · "hôm kia" · "bữa nay"
  if (f(0) === "hom" || f(0) === "bua") {
    if (f(1) === "nay") return day(today, 2);
    if (f(1) === "qua") return day(addDays(today, -1), 2);
    if (f(1) === "kia" || f(1) === "kia") return day(addDays(today, -2), 2);
  }
  if (f(0) === "nay" && i === 0 && tokens.length === 1) return day(today, 1);
  // "thứ 2", "thứ hai", "chủ nhật", "cn" (+ "tuần này" / "tuần trước")
  let wd: number | null = null;
  let len = 0;
  if (f(0) === "thu" && (/^[2-7]$/.test(f(1)) || WEEKDAY[f(1)] !== undefined)) {
    wd = /^\d$/.test(f(1)) ? +f(1) : WEEKDAY[f(1)];
    len = 2;
  } else if (/^t[2-7]$/.test(f(0))) {
    wd = +f(0).slice(1);
    len = 1;
  } else if (f(0) === "chu" && f(1) === "nhat") {
    wd = 8;
    len = 2;
  } else if (f(0) === "cn") {
    wd = 8;
    len = 1;
  }
  if (wd !== null) {
    const monday = mondayOf(today);
    if (f(len) === "tuan" && past(f(len + 1))) return day(addDays(monday, wd - 2 - 7), len + 2);
    if (f(len) === "tuan" && f(len + 1) === "nay") {
      const d = addDays(monday, wd - 2);
      return day(d <= today ? d : addDays(d, -7), len + 2);
    }
    // không ghi tuần: ngày gần nhất đã qua (kể cả hôm nay)
    const d = addDays(monday, wd - 2);
    return day(d <= today ? d : addDays(d, -7), len);
  }
  // "3 ngày trước" · "7 ngày qua" / "30 ngày gần đây" (kỳ)
  if (/^\d{1,3}$/.test(f(0)) && f(1) === "ngay") {
    const n = +f(0);
    if (f(2) === "truoc") return day(addDays(today, -n), 3);
    if (f(2) === "qua" || f(2) === "gan" || f(2) === "vua") {
      const extra = f(2) === "gan" && f(3) === "day" ? 4 : f(2) === "vua" && f(3) === "qua" ? 4 : 3;
      return range(addDays(today, -(n - 1)), today, extra);
    }
  }
  // "ngày 5" · "ngày 5/11" · "ngày 05.11"
  if (f(0) === "ngay") {
    const d = parseDayMonth(f(1), today, true) ?? isoDay(f(1));
    if (d) return day(d, 2);
    if (/^\d{1,2}$/.test(f(1)) && !/^(may|con|chiec|cai|truoc|qua)$/.test(f(2))) {
      const dd = +f(1);
      let out = valid(y, mo, dd) ? iso(y, mo, dd) : null;
      if (out && out > today) out = valid(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1, dd) ? iso(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1, dd) : null;
      if (out) return day(out, 2);
    }
  }
  // "5/11" · "05-11-2026" · ISO
  {
    const d = parseDayMonth(f(0), today) ?? isoDay(f(0));
    if (d) return day(d, 1);
  }
  // "tuần này" · "tuần trước"
  if (f(0) === "tuan") {
    const monday = mondayOf(today);
    if (f(1) === "nay") return range(monday, today, 2);
    if (past(f(1))) return range(addDays(monday, -7), addDays(monday, -1), 2);
  }
  // "tháng này" · "tháng trước" · "tháng 11" · "tháng 11/2025" · "t11"
  if (f(0) === "thang" || /^t\d{1,2}$/.test(f(0))) {
    if (f(0) === "thang" && (f(1) === "nay" || f(1) === "hien")) return preset("thang", 2);
    if (f(0) === "thang" && past(f(1))) return preset("thang-truoc", 2);
    const raw = f(0) === "thang" ? f(1) : f(0).slice(1);
    const m = /^(\d{1,2})(?:[/-](\d{4}))?$/.exec(raw);
    if (m && +m[1] >= 1 && +m[1] <= 12) {
      let yy = m[2] ? +m[2] : y;
      let consumed = f(0) === "thang" ? 2 : 1;
      if (!m[2] && f(consumed) === "nam" && /^\d{4}$/.test(f(consumed + 1))) {
        yy = +f(consumed + 1);
        consumed += 2;
      } else if (!m[2] && f(consumed) === "nam" && past(f(consumed + 1))) {
        yy = y - 1;
        consumed += 2;
      }
      if (!m[2] && yy === y && +m[1] > mo) yy = y - 1;
      return range(iso(yy, +m[1], 1), iso(yy, +m[1], lastDay(yy, +m[1])), consumed);
    }
  }
  // "quý này" · "quý trước" · "quý 3" · "quý 3/2025" · "q3"
  if (f(0) === "quy" || /^q[1-4]$/.test(f(0))) {
    if (f(0) === "quy" && f(1) === "nay") return preset("quy", 2);
    if (f(0) === "quy" && past(f(1))) return preset("quy-truoc", 2);
    const raw = f(0) === "quy" ? f(1) : f(0).slice(1);
    const m = /^([1-4]|i{1,3}|iv)(?:[/-](\d{4}))?$/.exec(raw);
    if (m) {
      const q = { i: 1, ii: 2, iii: 3, iv: 4 }[m[1]] ?? +m[1];
      let yy = m[2] ? +m[2] : y;
      let consumed = f(0) === "quy" ? 2 : 1;
      if (!m[2] && f(consumed) === "nam" && /^\d{4}$/.test(f(consumed + 1))) {
        yy = +f(consumed + 1);
        consumed += 2;
      }
      if (!m[2] && yy === y && q > quarterOf(today)) yy = y - 1;
      const sm = (q - 1) * 3 + 1;
      return range(iso(yy, sm, 1), iso(yy, sm + 2, lastDay(yy, sm + 2)), consumed);
    }
  }
  // "năm nay" · "năm ngoái" · "năm 2025"
  if (f(0) === "nam") {
    if (f(1) === "nay") return preset("nam", 2);
    if (past(f(1))) return preset("nam-truoc", 2);
    if (/^20\d{2}$/.test(f(1))) return range(`${f(1)}-01-01`, `${f(1)}-12-31`, 2);
  }
  // "đầu tháng" → từ mùng 1 tới nay
  if (f(0) === "dau" && f(1) === "thang") return range(iso(y, mo, 1), today, 2);
  return null;
}

/** Ngày hiển thị: "2026-11-05" → "05/11/2026". */
export const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
