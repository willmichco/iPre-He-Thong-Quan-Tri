/**
 * Phân bổ một khoản tiền cho nhiều máy theo trọng số — phương pháp PHẦN DƯ LỚN NHẤT (largest remainder).
 * Tài liệu 04, mục 3.1. Hàm thuần, số nguyên tuyệt đối (bigint), không làm tròn số thực.
 *
 * Bất biến (kiểm thử thuộc tính trong tests/unit/costing-allocation.test.ts):
 *  1. Σ kết quả === total — luôn luôn, không lệch 1 đồng.
 *  2. Mỗi phần chênh với tỷ lệ lý thuyết total × wᵢ / Σw dưới 1 đồng.
 *  3. Tất định: cùng đầu vào → cùng đầu ra; hoà phần dư thì máy đứng trước được cộng trước.
 *  4. Khoản âm (hoàn phí, giảm giá) phân bổ đối xứng với khoản dương.
 */
import { CostingError } from "./errors";

export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new CostingError("EMPTY_WEIGHTS", "Không có máy để phân bổ");
  if (weights.some((w) => w < 0n)) throw new CostingError("NEGATIVE_WEIGHT", "Trọng số phân bổ không được âm");
  const sumW = weights.reduce((a, b) => a + b, 0n);
  if (sumW === 0n) throw new CostingError("ZERO_WEIGHT", "Tổng trọng số phân bổ bằng 0");
  if (total === 0n) return weights.map(() => 0n);

  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const base = weights.map((w) => (abs * w) / sumW);
  const rem = weights.map((w) => (abs * w) % sumW); // phần lẻ = rem / sumW
  let left = abs - base.reduce((a, b) => a + b, 0n);
  const order = weights.map((_, i) => i).sort((a, b) => (rem[b] > rem[a] ? 1 : rem[b] < rem[a] ? -1 : a - b));
  for (let k = 0; left > 0n; k++, left--) base[order[k]] += 1n;
  return base.map((v) => v * sign);
}

/** Chia đều theo số lượng (mỗi máy trọng số 1). */
export function allocateEvenly(total: bigint, count: number): bigint[] {
  return allocate(
    total,
    Array.from({ length: count }, () => 1n),
  );
}
