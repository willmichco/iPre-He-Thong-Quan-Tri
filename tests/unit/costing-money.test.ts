import { describe, expect, it } from "vitest";
import { divRound, formatBp, formatVnd, parseScaled, percentBp, toVnd } from "@/domain/costing";

describe("tiền tệ chính xác bằng bigint", () => {
  it("parseScaled: chuỗi, số, bigint; chữ số 0 thừa được bỏ qua", () => {
    expect(parseScaled("1199.00", 2)).toBe(119_900n);
    expect(parseScaled("1199.5", 2)).toBe(119_950n);
    expect(parseScaled(26400, 4)).toBe(264_000_000n);
    expect(parseScaled("-20", 2)).toBe(-2000n);
    expect(parseScaled("0.600", 3)).toBe(600n);
    expect(parseScaled("1.2300", 2)).toBe(123n);
    expect(parseScaled(5n, 2)).toBe(500n);
    expect(parseScaled(0.1, 2)).toBe(10n);
  });

  it("parseScaled từ chối số sai dạng hoặc nhiều chữ số lẻ hơn cho phép", () => {
    expect(() => parseScaled("1,5", 2)).toThrow(/không hợp lệ/);
    expect(() => parseScaled("abc", 2)).toThrow();
    expect(() => parseScaled("1.234", 2)).toThrow(/chữ số thập phân/);
    expect(() => parseScaled(Number.NaN, 2)).toThrow();
  });

  it("divRound làm tròn nửa ra xa số 0 như PostgreSQL round()", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(5n, -2n)).toBe(-3n);
    expect(() => divRound(1n, 0n)).toThrow();
  });

  it("toVnd = round(số tiền × tỷ giá)", () => {
    expect(toVnd("20.00", "26400")).toBe(528_000n);
    expect(toVnd("1199", 26400)).toBe(31_653_600n);
    expect(toVnd("0.01", "25432.5")).toBe(254n); // 254,325 → 254
    expect(toVnd("0.02", "25432.5")).toBe(509n); // 508,65 → 509
    expect(toVnd(684000)).toBe(684_000n);
  });

  it("định dạng tiền và phần trăm kiểu Việt Nam", () => {
    expect(formatVnd(55_943_208n)).toBe("55.943.208");
    expect(formatVnd(-30_000n)).toBe("−30.000");
    expect(percentBp(2_706_128n, 48_963_872n)).toBe(553);
    expect(percentBp(1n, 0n)).toBeNull();
    expect(formatBp(553)).toBe("5,53%");
    expect(formatBp(-7)).toBe("−0,07%");
    expect(formatBp(null)).toBe("—");
  });
});
