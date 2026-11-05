import { describe, expect, it } from "vitest";
import { alertSettingsFrom } from "@/domain/overview";
import { displayValue, parseSetting, SETTINGS } from "@/domain/settings";
import { csvCell } from "@/server/settings/service";

const def = (k: string) => SETTINGS.find((s) => s.key === k)!;

describe("Cài đặt", () => {
  it("hiển thị giá trị đang lưu; hỏng / thiếu → mặc định", () => {
    expect(displayValue(def("alert.aging_days"), 45)).toBe("45");
    expect(displayValue(def("alert.aging_days"), "abc")).toBe("30");
    expect(displayValue(def("tax.revenue_threshold_vnd"), 1_000_000_000)).toBe("1.000.000.000");
    expect(displayValue(def("tax.revenue_threshold_vnd"), undefined)).toBe("1.000.000.000");
    expect(displayValue(def("tax.threshold_warning_ratio"), 0.75)).toBe("75");
    expect(displayValue(def("tax.threshold_warning_ratio"), 0.825)).toBe("82,5");
    expect(displayValue(def("tax.threshold_warning_ratio"), 5)).toBe("80");
    expect(displayValue(def("costing.returned_item_policy"), "WRITE_OFF")).toBe("WRITE_OFF");
    expect(displayValue(def("costing.returned_item_policy"), "XYZ")).toBe("REALLOCATE");
  });
  it("đọc ô nhập: giới hạn, đơn vị tiếng Việt", () => {
    expect(parseSetting(def("alert.aging_days"), " 45 ")).toEqual({ ok: true, value: 45 });
    expect(parseSetting(def("alert.aging_days"), "0")).toMatchObject({ ok: false, error: expect.stringContaining("từ 1 đến 365 ngày") });
    expect(parseSetting(def("alert.aging_days"), "4,5")).toMatchObject({ ok: false });
    expect(parseSetting(def("tax.revenue_threshold_vnd"), "1 tỷ")).toEqual({ ok: true, value: 1_000_000_000 });
    expect(parseSetting(def("tax.revenue_threshold_vnd"), "500tr")).toEqual({ ok: true, value: 500_000_000 });
    expect(parseSetting(def("tax.revenue_threshold_vnd"), "0")).toMatchObject({ ok: false });
    expect(parseSetting(def("tax.threshold_warning_ratio"), "82,5%")).toEqual({ ok: true, value: 0.825 });
    expect(parseSetting(def("tax.threshold_warning_ratio"), "120")).toMatchObject({ ok: false });
    expect(parseSetting(def("costing.returned_item_policy"), "WRITE_OFF")).toEqual({ ok: true, value: "WRITE_OFF" });
    expect(parseSetting(def("costing.returned_item_policy"), "DROP TABLE")).toMatchObject({ ok: false });
  });
  it("giá trị lưu từ trang Cài đặt được Tổng quan đọc đúng", () => {
    const saved = [
      { key: "alert.aging_days", value: JSON.stringify(45) },
      { key: "tax.revenue_threshold_vnd", value: JSON.stringify(500_000_000) },
      { key: "tax.threshold_warning_ratio", value: JSON.stringify(0.825) },
    ];
    expect(alertSettingsFrom(saved)).toMatchObject({ agingDays: 45, revenueThresholdVnd: 500_000_000n, thresholdWarningRatio: 0.825 });
  });
  it("ô CSV theo RFC 4180", () => {
    expect([csvCell(null), csvCell(12n), csvCell("a,b"), csvCell('nói "hay"'), csvCell("2\ndòng"), csvCell({ a: 1 })]).toEqual([
      "",
      "12",
      '"a,b"',
      '"nói ""hay"""',
      '"2\ndòng"',
      '"{""a"":1}"',
    ]);
    expect(csvCell(new Date("2026-11-05T03:00:00Z"))).toBe("2026-11-05T03:00:00.000Z");
  });
});
