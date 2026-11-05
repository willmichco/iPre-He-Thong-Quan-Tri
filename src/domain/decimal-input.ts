/** Ô số thập phân gõ tay — tách khỏi catalog.ts (không kéo theo zod) để dùng được ở thành phần trình duyệt. */
/**
 * Đọc số thập phân người dùng gõ: "0,6" · "0.6" · "1.199,00" · "1,199.00" · "$1,199" → chuỗi chuẩn "1199.00".
 * Trả null nếu không phải số hoặc quá `scale` chữ số thập phân.
 */
export function parseDecimalInput(raw: string, scale: number): string | null {
  let s = raw.trim().replace(/[\s$₫đ]/gi, "");
  if (!s) return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let intPart: string;
  let frac = "";
  if (lastDot >= 0 && lastComma >= 0) {
    // dấu xuất hiện sau cùng là dấu thập phân, dấu còn lại là phân cách hàng nghìn
    const dec = lastDot > lastComma ? "." : ",";
    const group = dec === "." ? "," : ".";
    const [i, f] = [s.slice(0, s.lastIndexOf(dec)), s.slice(s.lastIndexOf(dec) + 1)];
    const groups = i.split(group);
    // phần nguyên chỉ được chứa dấu hàng nghìn, mỗi nhóm sau nhóm đầu đúng 3 chữ số
    if (i.includes(dec) || groups.slice(1).some((g) => g.length !== 3)) return null;
    intPart = groups.join("");
    frac = f;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    // "1.199" / "1,199": nhiều nhóm, hoặc đúng 3 chữ số sau dấu mà số thập phân cho phép < 3 → hàng nghìn
    // (USD "1,199" = 1199; cân nặng "1,199" kg = 1,199) ; còn lại → thập phân
    const thousands = parts.length > 2 || (scale < 3 && parts[0] !== "0" && parts.slice(1).every((p) => p.length === 3));
    if (thousands) {
      if (parts.slice(1).some((p) => p.length !== 3)) return null;
      intPart = parts.join("");
    } else {
      intPart = parts[0];
      frac = parts[1];
    }
  } else intPart = s;
  if (!/^\d+$/.test(intPart || "0") || !/^\d*$/.test(frac)) return null;
  if (frac.length > scale) return null;
  const int = (intPart || "0").replace(/^0+(?=\d)/, "");
  const out = scale ? `${int}.${frac.padEnd(scale, "0")}` : int;
  return neg ? `-${out}` : out;
}

/**
 * Tỷ giá VND/USD: "26.350" / "26,350" là 26.350 đồng (dấu hàng nghìn kiểu Việt Nam), không phải 26,35.
 * "26.350,5" / "26350.5" vẫn đọc phần lẻ bình thường. Tối đa 4 chữ số thập phân.
 */
export function parseFxRate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return parseDecimalInput(s.replace(/[.,]/g, ""), 4);
  return parseDecimalInput(s, 4);
}
