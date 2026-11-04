/**
 * Tiền và số thập phân CHÍNH XÁC bằng bigint — không dùng số thực (float) ở bất kỳ bước nào.
 *
 * Quy ước khớp với CSDL (db/migrations/0001_khoi_tao.sql):
 *  - Tiền VND: bigint (đồng).
 *  - Số tiền theo tiền tệ gốc: numeric(…,2) → chuỗi "1199.00" → bigint theo xu (scale 2).
 *  - Tỷ giá: numeric(12,4) → scale 4.   Cân nặng: numeric(…,3) → scale 3 (gam).
 *  - Làm tròn như PostgreSQL `round(numeric)`: nửa đơn vị làm tròn RA XA số 0 (2,5 → 3; −2,5 → −3).
 */
import { CostingError } from "./errors";

export type Vnd = bigint;

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** "1199.5" (scale 2) → 119950n. Nhận cả number hữu hạn. Từ chối nếu có nhiều chữ số lẻ hơn `scale` (khác 0). */
export function parseScaled(value: string | number | bigint, scale: number): bigint {
  if (typeof value === "bigint") return value * 10n ** BigInt(scale);
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  const m = DECIMAL.exec(text);
  if (!m) throw new CostingError("INVALID_NUMBER", `Số không hợp lệ: "${value}"`);
  const [, sign, int, frac = ""] = m;
  const extra = frac.slice(scale);
  if (/[1-9]/.test(extra)) throw new CostingError("INVALID_NUMBER", `Số "${value}" có nhiều hơn ${scale} chữ số thập phân`);
  const digits = BigInt(int + frac.slice(0, scale).padEnd(scale, "0"));
  return sign === "-" ? -digits : digits;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new CostingError("INVALID_NUMBER", `Số không hợp lệ: ${n}`);
  // toFixed(10) đủ cho mọi giá trị tiền/tỷ giá thực tế, tránh dạng mũ 1e-7
  return n.toFixed(10).replace(/\.?0+$/, "");
}

/** Chia làm tròn nửa ra xa số 0 (giống PostgreSQL round). */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new CostingError("INVALID_NUMBER", "Chia cho 0");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/** round(amount × fxRate) — đúng công thức cột `amount_vnd` / `total_vnd` trong CSDL. */
export function toVnd(amount: string | number, fxRate: string | number = 1): Vnd {
  const a = parseScaled(amount, 2);
  const r = parseScaled(fxRate, 4);
  return divRound(a * r, 10n ** 6n);
}

/** Định dạng tiền Việt: 55943208n → "55.943.208". */
export function formatVnd(v: Vnd): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return neg ? `−${s}` : s;
}

/**
 * Tỷ lệ phần trăm làm tròn 2 chữ số (đơn vị: phần trăm của phần trăm — "basis point").
 * percentBp(2706128n, 48963872n) → 553 (= 5,53%). Mẫu số ≤ 0 → null (không có ý nghĩa).
 */
export function percentBp(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number(divRound(numerator * 10000n, denominator));
}
