import { describe, expect, it } from "vitest";
import {
  agingBucket,
  alertSettingsFrom,
  buildAlerts,
  capitalByStage,
  changeBp,
  DEFAULT_ALERT_SETTINGS,
  fillMonths,
  formatBp,
  last12Months,
  parsePeriod,
  periodRange,
  shortVnd,
  stageForStatus,
  stockSummary,
  type AlertInput,
} from "@/domain/overview";

describe("kỳ báo cáo", () => {
  it("tháng này / tháng trước / năm nay — đầu gồm, cuối không gồm", () => {
    expect(periodRange("thang-nay", "2026-11-04")).toMatchObject({
      from: "2026-11-01",
      to: "2026-12-01",
      prevFrom: "2026-10-01",
      prevTo: "2026-11-01",
      label: "Tháng 11/2026",
    });
    expect(periodRange("thang-truoc", "2026-01-15")).toMatchObject({ from: "2025-12-01", to: "2026-01-01", prevFrom: "2025-11-01", prevTo: "2025-12-01" });
    expect(periodRange("nam-nay", "2026-11-04")).toMatchObject({
      from: "2026-01-01",
      to: "2026-11-05",
      prevFrom: "2025-01-01",
      prevTo: "2025-11-05",
      prevLabel: "cùng kỳ 2025",
    });
    expect(periodRange("nam-nay", "2026-12-31").to).toBe("2027-01-01");
  });
  it("giá trị lạ → tháng này", () => {
    expect(parsePeriod("nam-nay")).toBe("nam-nay");
    expect(parsePeriod("x")).toBe("thang-nay");
    expect(parsePeriod(undefined)).toBe("thang-nay");
  });
  it("12 tháng qua năm, điền tháng trống bằng 0", () => {
    const m = last12Months("2026-02-10");
    expect(m[0]).toBe("2025-03-01");
    expect(m[11]).toBe("2026-02-01");
    const f = fillMonths(m, [{ month: "2026-01-01", revenueVnd: 5n, profitVnd: 1n, units: 1 }]);
    expect(f).toHaveLength(12);
    expect(f[10]).toEqual({ month: "2026-01-01", revenueVnd: 5n, profitVnd: 1n, units: 1 });
    expect(f[0].revenueVnd).toBe(0n);
  });
});

describe("vốn theo chặng", () => {
  it("gom trạng thái về chặng, tỷ trọng và vốn còn trên đường", () => {
    const r = capitalByStage([
      { status: "INTL_IN_TRANSIT", itemCount: 2, capitalVnd: 60_000_000n },
      { status: "IN_STOCK", itemCount: 3, capitalVnd: 30_000_000n },
      { status: "RESERVED", itemCount: 1, capitalVnd: 10_000_000n },
    ]);
    expect(r.totalVnd).toBe(100_000_000n);
    expect(r.itemCount).toBe(6);
    expect(r.onTheWayVnd).toBe(60_000_000n);
    const sg = r.stages.find((s) => s.key === "sg")!;
    expect(sg).toMatchObject({ itemCount: 4, capitalVnd: 40_000_000n, shareBp: 4000 });
    expect(r.stages.map((s) => s.key)).toEqual(["ordered", "us", "us-wh", "intl", "hn", "hn-sg", "sg", "warranty"]);
  });
  it("không có máy → tỷ trọng 0", () => {
    expect(capitalByStage([]).stages.every((s) => s.shareBp === 0)).toBe(true);
  });
  it("trạng thái → chặng", () => {
    expect(stageForStatus("AT_HN")).toBe("hn");
    expect(stageForStatus("RESERVED")).toBe("sg");
    expect(stageForStatus("SOLD")).toBeNull();
  });
});

describe("số gọn", () => {
  it.each([
    [412_500_000n, "412,5 tr"],
    [1_234_000_000n, "1,2 tỷ"],
    [12_345_000_000_000n, "12.345 tỷ"],
    [18_400_000n, "18,4 tr"],
    [2_000_000n, "2 tr"],
    [1_960_000n, "2 tr"],
    [30_000n, "30 k"],
    [999n, "999"],
    [0n, "0"],
    [-2_706_128n, "−2,7 tr"],
  ])("%s → %s", (v, s) => expect(shortVnd(v)).toBe(s));
  it("phần trăm & thay đổi", () => {
    expect(formatBp(553)).toBe("5,53 %");
    expect(formatBp(-7)).toBe("−0,07 %");
    expect(formatBp(null)).toBe("—");
    expect(changeBp(120n, 100n)).toBe(2000);
    expect(changeBp(50n, -100n)).toBe(15000);
    expect(changeBp(5n, 0n)).toBeNull();
  });
});

describe("tồn kho", () => {
  it("nhóm tuổi tồn & trung bình", () => {
    expect([0, 15, 16, 30, 31, 60, 61].map(agingBucket)).toEqual(["0-15", "0-15", "16-30", "16-30", "31-60", "31-60", ">60"]);
    const s = stockSummary([
      { days: 10, costVnd: 1n },
      { days: 41, costVnd: 2n },
      { days: null, costVnd: 4n },
    ]);
    expect(s).toMatchObject({ count: 3, costVnd: 7n, avgDays: 26 });
    expect(s.buckets.map((b) => b.count)).toEqual([1, 0, 1, 0]);
    expect(stockSummary([]).avgDays).toBeNull();
  });
});

describe("cài đặt cảnh báo", () => {
  it("đọc app_settings, giá trị hỏng giữ mặc định", () => {
    const s = alertSettingsFrom([
      { key: "alert.aging_days", value: "45" },
      { key: "alert.eta_grace_days", value: '"abc"' },
      { key: "tax.revenue_threshold_vnd", value: "500000000" },
      { key: "tax.threshold_warning_ratio", value: "0.9" },
    ]);
    expect(s).toEqual({ ...DEFAULT_ALERT_SETTINGS, agingDays: 45, revenueThresholdVnd: 500_000_000n, thresholdWarningRatio: 0.9 });
    expect(alertSettingsFrom([{ key: "tax.threshold_warning_ratio", value: "7" }]).thresholdWarningRatio).toBe(0.8);
  });
});

describe("bộ quy tắc Cần xử lý", () => {
  const base: AlertInput = {
    today: "2026-11-04",
    shipments: [],
    stock: [],
    returnDeadlines: [],
    receivables: [],
    depositsReady: [],
    yearRevenueVnd: 0n,
    year: 2026,
  };

  it("không có gì → rỗng", () => expect(buildAlerts(base)).toEqual([]));

  it("kiện trễ quá số ngày ân hạn; trong ân hạn thì không báo; giữ hải quan là gấp", () => {
    const a = buildAlerts({
      ...base,
      shipments: [
        { id: "a", label: "AWB-1", status: "IN_TRANSIT", eta: "2026-11-01", heldSince: null },
        { id: "b", label: "AWB-2", status: "IN_TRANSIT", eta: "2026-11-02", heldSince: null },
        { id: "c", label: "AWB-3", status: "HOLD", eta: null, heldSince: "2026-10-30 10:00:00+07" },
        { id: "d", label: "AWB-4", status: "IN_TRANSIT", eta: null, heldSince: null },
      ],
    });
    expect(a.map((x) => [x.kind, x.level, x.href])).toEqual([
      ["SHIPMENT_HOLD", "critical", "/van-chuyen/c"],
      ["SHIPMENT_LATE", "warning", "/van-chuyen/a"],
    ]);
    expect(a[0].title).toContain("5 ngày");
    expect(a[1].title).toContain("trễ 3 ngày");
  });

  it("máy tồn lâu: gom một dòng, > 2 lần ngưỡng thì 'chú ý'", () => {
    const stock = [
      { id: "1", label: "iPhone 17", days: 31, costVnd: 20_000_000n },
      { id: "2", label: "iPad", days: 10, costVnd: 9_000_000n },
    ];
    const [a] = buildAlerts({ ...base, stock });
    expect(a).toMatchObject({ kind: "AGED_STOCK", level: "info", href: "/kho/1" });
    expect(a.title).toBe("1 máy tồn quá 30 ngày — 20 tr vốn đứng");
    const [b] = buildAlerts({ ...base, stock: [...stock, { id: "3", label: "Mac", days: 70, costVnd: 1n }] });
    expect(b).toMatchObject({ level: "warning", href: "/kho" });
    expect(b.detail).toBe("Mac (70 ngày), iPhone 17 (31 ngày)");
  });

  it("hạn đổi trả: chỉ khi còn máy chưa kiểm, trong N ngày", () => {
    const rd = (deadline: string, pendingItems = 2) => ({ poId: "p", batchId: "b", label: "CH-1 · Apple", deadline, pendingItems });
    const a = buildAlerts({ ...base, returnDeadlines: [rd("2026-11-04"), rd("2026-11-06"), rd("2026-11-08"), rd("2026-11-05", 0)] });
    expect(a.map((x) => [x.level, x.title])).toEqual([
      ["critical", "Đơn mua CH-1 · Apple hết hạn đổi trả hôm nay"],
      ["warning", "Đơn mua CH-1 · Apple còn 2 ngày hết hạn đổi trả"],
    ]);
  });

  it("công nợ, đơn cọc đã về, ngưỡng doanh thu", () => {
    const a = buildAlerts({
      ...base,
      receivables: [
        { id: "s1", code: "BH-2026-0001", customer: "Anh A", status: "COMPLETED", balanceVnd: 5_000_000n },
        { id: "s2", code: "BH-2026-0002", customer: null, status: "DEPOSITED", balanceVnd: 20_000_000n },
        { id: "s3", code: "BH-2026-0003", customer: null, status: "COMPLETED", balanceVnd: 0n },
      ],
      depositsReady: [{ id: "s2", code: "BH-2026-0002", customer: null }],
      yearRevenueVnd: 850_000_000n,
    });
    expect(a.map((x) => x.kind)).toEqual(["TAX_THRESHOLD", "DEPOSIT_READY", "RECEIVABLE"]);
    expect(a[0].title).toBe("Doanh thu năm 2026 đạt 85 % ngưỡng 1 tỷ");
    expect(a[2]).toMatchObject({ title: "1 đơn bán khách còn nợ 5 tr", href: "/ban-hang/s1" });
    expect(buildAlerts({ ...base, yearRevenueVnd: 1_100_000_000n })[0].level).toBe("critical");
    expect(buildAlerts({ ...base, yearRevenueVnd: 700_000_000n })).toEqual([]);
  });
});
