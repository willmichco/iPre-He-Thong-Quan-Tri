import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, allocateEvenly, CostingError } from "@/domain/costing";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const total = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });
const weights = fc.array(fc.bigInt({ min: 0n, max: 10n ** 10n }), { minLength: 1, maxLength: 40 }).filter((w) => sum(w) > 0n);

describe("allocate — phần dư lớn nhất (tài liệu 04, mục 3.1)", () => {
  it("ví dụ tài liệu: 100.000 đ chia 3 máy → 33.334 + 33.333 + 33.333", () => {
    expect(allocateEvenly(100_000n, 3)).toEqual([33_334n, 33_333n, 33_333n]);
  });

  it("thuộc tính 1: Σ kết quả === tổng — không lệch 1 đồng (5.000 bộ ngẫu nhiên)", () => {
    fc.assert(
      fc.property(total, weights, (t, w) => sum(allocate(t, w)) === t),
      { numRuns: 5000 },
    );
  });

  it("thuộc tính 2: mỗi phần chênh với tỷ lệ lý thuyết dưới 1 đồng", () => {
    fc.assert(
      fc.property(total, weights, (t, w) => {
        const W = sum(w);
        return allocate(t, w).every((s, i) => {
          const diff = s * W - t * w[i]; // (s − t·wᵢ/W)·W
          return (diff < 0n ? -diff : diff) < W;
        });
      }),
      { numRuns: 3000 },
    );
  });

  it("thuộc tính 3: tất định — cùng đầu vào, cùng đầu ra", () => {
    fc.assert(
      fc.property(total, weights, (t, w) => JSON.stringify(allocate(t, w).map(String)) === JSON.stringify(allocate(t, [...w]).map(String))),
      { numRuns: 1000 },
    );
  });

  it("thuộc tính 4: khoản âm (hoàn phí) đối xứng với khoản dương", () => {
    fc.assert(
      fc.property(total, weights, (t, w) => allocate(-t, w).every((s, i) => s === -allocate(t, w)[i])),
      { numRuns: 1000 },
    );
  });

  it("máy trọng số 0 không nhận đồng nào; tổng 0 → toàn 0", () => {
    expect(allocate(1_000n, [0n, 1n, 1n])).toEqual([0n, 500n, 500n]);
    expect(allocate(0n, [1n, 2n])).toEqual([0n, 0n]);
  });

  it("hoà phần dư → máy đứng trước được cộng trước", () => {
    expect(allocate(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });

  it.each([
    ["rỗng", [], "EMPTY_WEIGHTS"],
    ["toàn 0", [0n, 0n], "ZERO_WEIGHT"],
    ["có số âm", [1n, -1n], "NEGATIVE_WEIGHT"],
  ] as [string, bigint[], string][])("trọng số %s → lỗi %s", (_name, w, code) => {
    expect(() => allocate(10n, w)).toThrowError(CostingError);
    expect(() => allocate(10n, w)).toThrow(expect.objectContaining({ code }));
  });
});
