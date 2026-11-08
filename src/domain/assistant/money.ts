/**
 * Trợ lý — đọc số tiền trong câu nhắn.
 * VND: "25tr" · "25tr5" · "25,5 củ" · "25 triệu 500" · "25 triệu rưỡi" · "25 triệu 500 nghìn" · "25.500.000đ" · "500k".
 * USD: "$899" · "899$" · "899 usd" · "899 đô" · "$1,199.99".
 * Số trần không đơn vị chỉ được coi là tiền khi có dấu hàng nghìn ("25.500.000") hoặc ≥ 5 chữ số và không giống SĐT / IMEI —
 * để "256" (dung lượng), "15" (đời máy) không bị đọc nhầm thành tiền.
 */
import { parseDecimalInput } from "../decimal-input";
import { parseVndInput } from "../sales-core";
import type { Token } from "./normalize";

export interface MoneyHit {
  vnd: bigint;
  /** vị trí token đầu và số token đã dùng */
  start: number;
  len: number;
  raw: string;
  /** cách hiểu khác khi số sau đơn vị có 2 chữ số ("25 triệu 50": 25.500.000 hay 25.050.000) */
  alt?: bigint;
}

export interface UsdHit {
  /** chuỗi thập phân chuẩn "1199.00" */
  usd: string;
  start: number;
  len: number;
  raw: string;
}

const UNIT_WORD: Record<string, number> = { k: 3, nghin: 3, ngan: 3, ng: 3, tr: 6, trieu: 6, cu: 6, ty: 9 };
const NUM = /^\d+(?:[.,]\d+)?$/;
const HALF = new Set(["ruoi", "ruo"]);
/** đơn vị (số chữ số 0) của một token tiền có chữ: "25tr5" → 6, "500k" → 3 */
const unitOfToken = (f: string): number | null => {
  const m = /^\d+(?:[.,]\d+)?(k|nghin|ngan|ng|tr|trieu|cu|m|ty|b)\d{0,3}(?:d|vnd)?$/.exec(f.replace(/\s+/g, ""));
  return m ? ({ k: 3, nghin: 3, ngan: 3, ng: 3, tr: 6, trieu: 6, cu: 6, m: 6, ty: 9, b: 9 } as Record<string, number>)[m[1]] : null;
};
const pow10 = (n: number) => 10n ** BigInt(n);

/** "25" + đơn vị 6 + phần lẻ "5" → 25.500.000 (phần lẻ là các chữ số sau dấu phẩy) */
function withFraction(int: string, frac: string, unit: number): bigint | null {
  if (frac.length > unit) return null;
  return BigInt(int) * pow10(unit) + (frac ? BigInt(frac.padEnd(unit, "0")) : 0n);
}

/** số trần có thể là tiền VND không (không phải dung lượng, đời máy, SĐT, IMEI) */
function plainVnd(f: string): bigint | null {
  const s = f.replace(/(vnd|d)$/, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return BigInt(s.replace(/[.,]/g, ""));
  if (/^\d{5,9}$/.test(s) && !s.startsWith("0")) return BigInt(s);
  return null;
}

/** Đọc tiền VND bắt đầu tại token i. */
export function moneyAt(tokens: readonly Token[], i: number): MoneyHit | null {
  const t = tokens[i];
  if (!t || !/^\d/.test(t.f)) return null;
  const next = tokens[i + 1]?.f;
  const hit = (vnd: bigint, len: number, alt?: bigint): MoneyHit => ({
    vnd,
    start: i,
    len,
    raw: tokens
      .slice(i, i + len)
      .map((x) => x.raw)
      .join(" "),
    ...(alt !== undefined && alt !== vnd ? { alt } : {}),
  });

  let base: { vnd: bigint; unit: number; len: number } | null = null;
  if (NUM.test(t.f) && next && UNIT_WORD[next] !== undefined) {
    // "25 triệu", "25,5 củ"
    const unit = UNIT_WORD[next];
    const [int, frac = ""] = t.f.split(/[.,]/);
    const v = withFraction(int, frac, unit);
    if (v !== null) base = { vnd: v, unit, len: 2 };
  } else {
    const unit = unitOfToken(t.f);
    if (unit !== null) {
      const v = parseVndInput(t.f);
      if (v !== null) base = { vnd: v, unit, len: 1 };
    }
  }
  if (base) {
    let { vnd, len } = base;
    const { unit } = base;
    let alt: bigint | undefined;
    const after = tokens[i + len]?.f;
    const after2 = tokens[i + len + 1]?.f;
    if (after && HALF.has(after)) {
      vnd += pow10(unit) / 2n;
      len += 1;
    } else if (after && /^\d{1,3}$/.test(after) && base.len === 2 && !(after2 && UNIT_WORD[after2] !== undefined && UNIT_WORD[after2] >= unit)) {
      // "25 triệu 500" (nói tắt phần lẻ) hoặc "25 triệu 500 nghìn" (cộng hai phần)
      if (after2 && UNIT_WORD[after2] !== undefined && UNIT_WORD[after2] < unit) {
        vnd += BigInt(after) * pow10(UNIT_WORD[after2]);
        len += 2;
      } else if (after.length <= unit) {
        const frac = after.padEnd(unit, "0");
        const v = vnd + BigInt(frac);
        // 2 chữ số: "25 triệu 50" → hiểu 25.500.000, cách khác 25.050.000
        if (after.length === 2) alt = vnd + BigInt(after) * pow10(unit - 3);
        vnd = v;
        len += 1;
      }
    } else if (after) {
      // "25tr 500k": cộng phần đơn vị nhỏ hơn
      const more = moneyAt(tokens, i + len);
      const moreUnit = more ? (unitOfToken(tokens[i + len].f) ?? UNIT_WORD[tokens[i + len + 1]?.f ?? ""] ?? null) : null;
      if (more && moreUnit !== null && moreUnit < unit) {
        vnd += more.vnd;
        len += more.len;
      }
    }
    // "25tr đồng" / "25 triệu vnd"
    const tail = tokens[i + len]?.f;
    if (tail === "dong" || tail === "vnd" || tail === "d") len += 1;
    return hit(vnd, len, alt);
  }
  const plain = plainVnd(t.f);
  if (plain !== null) {
    const tail = next;
    return hit(plain, tail === "dong" || tail === "vnd" || tail === "d" ? 2 : 1);
  }
  // số nhỏ kèm chữ "đồng" / "vnd": "500000 đồng"
  if (/^\d+$/.test(t.f) && (next === "dong" || next === "vnd")) return hit(BigInt(t.f), 2);
  return null;
}

/** Đọc tiền USD bắt đầu tại token i. */
export function usdAt(tokens: readonly Token[], i: number): UsdHit | null {
  const t = tokens[i];
  if (!t) return null;
  const next = tokens[i + 1]?.f;
  const mk = (s: string, len: number): UsdHit | null => {
    const usd = parseDecimalInput(s, 2);
    return usd && Number(usd) > 0
      ? {
          usd,
          start: i,
          len,
          raw: tokens
            .slice(i, i + len)
            .map((x) => x.raw)
            .join(" "),
        }
      : null;
  };
  let m = /^\$(\d[\d.,]*)$/.exec(t.f) ?? /^(\d[\d.,]*)\$$/.exec(t.f) ?? /^(\d[\d.,]*)(usd|do|dola|dollar)$/.exec(t.f);
  if (m) return mk(m[1], 1);
  m = /^(\d[\d.,]*)$/.exec(t.f);
  if (m && next && /^(\$|usd|do|dola|dollar|đo)$/.test(next)) return mk(m[1], 2);
  return null;
}

/** Định dạng VND kiểu Việt Nam: 25500000n → "25.500.000 đ". */
export const formatVnd = (v: bigint) => `${v < 0n ? "−" : ""}${(v < 0n ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} đ`;

/** Rút gọn: 25500000n → "25,5 tr" · 1200000000n → "1,2 tỷ" · 500000n → "500k". */
export function shortVnd(v: bigint): string {
  const a = v < 0n ? -v : v;
  const sign = v < 0n ? "−" : "";
  const fmt = (n: bigint, unit: bigint, suffix: string) => {
    const int = n / unit;
    const frac = ((n % unit) * 100n) / unit;
    const f = frac === 0n ? "" : `,${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
    return `${sign}${int}${f} ${suffix}`;
  };
  if (a >= 1_000_000_000n) return fmt(a, 1_000_000_000n, "tỷ");
  if (a >= 1_000_000n) return fmt(a, 1_000_000n, "tr");
  if (a >= 1_000n) return `${sign}${a / 1000n}${a % 1000n ? `.${(a % 1000n).toString().padStart(3, "0")}` : ""}k`;
  return `${sign}${a} đ`;
}
