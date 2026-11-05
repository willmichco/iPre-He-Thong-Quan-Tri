/**
 * Sao lưu — hàm thuần: tên tệp theo thời điểm, chính sách giữ bản (30 bản ngày gần nhất + 12 bản tháng gần nhất).
 * Tài liệu 04 mục 7: pg_dump mã hoá hằng ngày lúc 02:00, giữ 30 bản ngày + 12 bản tháng; tài liệu 06 rủi ro #4.
 */

const NAME_RE = /^ipre-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ipbak$/;

/** "ipre-20261105-020000.ipbak" theo giờ UTC (tên không phụ thuộc múi giờ máy chủ). */
export function backupName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `ipre-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.ipbak`;
}

/** Tên tệp → thời điểm; không đúng mẫu → null (tệp lạ trong thư mục không bao giờ bị xoá). */
export function parseBackupName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null;
}

/**
 * Chọn bản giữ / bản xoá. Giữ: bản mới nhất của mỗi ngày trong `days` ngày gần nhất (có bản sao lưu),
 * bản mới nhất của mỗi tháng trong `months` tháng gần nhất, và luôn giữ bản mới nhất. Ngày / tháng tính theo giờ VN.
 * Tệp không đúng mẫu tên → không động tới.
 */
export function retention(names: readonly string[], opts: { days?: number; months?: number } = {}): { keep: string[]; remove: string[] } {
  const days = opts.days ?? 30;
  const months = opts.months ?? 12;
  const vn = (t: Date) => new Date(t.getTime() + 7 * 3_600_000).toISOString();
  const dated = names
    .flatMap((n) => {
      const t = parseBackupName(n);
      return t ? [{ n, t, day: vn(t).slice(0, 10), month: vn(t).slice(0, 7) }] : [];
    })
    .sort((a, b) => b.t.getTime() - a.t.getTime()); // mới → cũ
  const keep = new Set<string>();
  if (dated.length) keep.add(dated[0].n);
  const pick = (key: "day" | "month", limit: number) => {
    const seen = new Set<string>();
    for (const b of dated) {
      if (seen.has(b[key])) continue;
      if (seen.size >= limit) break;
      seen.add(b[key]);
      keep.add(b.n); // bản đầu tiên gặp của mỗi ngày / tháng = bản mới nhất
    }
  };
  pick("day", days);
  pick("month", months);
  return { keep: dated.filter((b) => keep.has(b.n)).map((b) => b.n), remove: dated.filter((b) => !keep.has(b.n)).map((b) => b.n) };
}
