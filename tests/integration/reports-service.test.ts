/**
 * Báo cáo ↔ PostgreSQL thật (đã nạp db/seed-vi-du.sql). Chỉ đọc (vài ca ghi thêm trong transaction rồi HUỶ).
 * Chuyến ví dụ CH-2026-011: bán iPhone 34,5 tr (Facebook, 23/10) + iPad 17,2 tr (Zalo, 27/10); AirPods còn tồn.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseRange } from "@/domain/reports";
import { exportReport } from "@/server/reports/export";
import * as r from "@/server/reports/service";
import { buildXlsx } from "@/server/reports/xlsx";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

class Rollback extends Error {}
async function inTx(fn: (tx: TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const OCT = parseRange({ ky: "thang-truoc" }, "2026-11-05"); // tháng 10/2026

describe("Báo cáo ↔ PostgreSQL", () => {
  it("lãi lỗ tháng 10: khớp chuyến ví dụ (lãi ròng = lãi chuyến 2.706.128 − quảng cáo 500.000)", async () => {
    expect(await r.pnlTotals(sql, OCT.from, OCT.toExcl)).toEqual({
      units: 2,
      revenueVnd: 51_700_000n,
      cogsVnd: 48_963_872n,
      sellingExpenseVnd: 30_000n,
      opexVnd: 500_000n,
      provisional: 0,
    });
    expect(await r.pnlTotals(sql, OCT.prevFrom, OCT.prevToExcl)).toMatchObject({ units: 0, revenueVnd: 0n });
    expect(await r.opexByCategory(sql, OCT.from, OCT.toExcl)).toEqual([{ code: "OPEX_ADS", name: "Quảng cáo", amountVnd: 500_000n }]);
    const q4 = await r.monthlyPnl(sql, "2026-10-01", "2027-01-01");
    expect(q4.map((m) => [m.month, m.units, m.netVnd])).toEqual([
      ["2026-10-01", 2, 2_206_128n],
      ["2026-11-01", 0, 0n],
      ["2026-12-01", 0, 0n],
    ]);
  });

  it("dòng máy, kênh bán, chuyến", async () => {
    const m = await r.byModel(sql, OCT.from, OCT.toExcl);
    expect(m.rows.map((x) => [x.category, x.units, x.revenueVnd, x.profitVnd, x.avgDaysToSell])).toEqual([
      ["IPHONE", 1, 34_500_000n, 2_045_864n, 2.9],
      ["IPAD", 1, 17_200_000n, 660_264n, 6.8],
    ]);
    expect(m.medianDays).toBe(4.85);
    expect(await r.byChannel(sql, OCT.from, OCT.toExcl)).toEqual([
      { channel: "FACEBOOK", orders: 1, units: 1, revenueVnd: 34_500_000n, profitVnd: 2_045_864n },
      { channel: "ZALO", orders: 1, units: 1, revenueVnd: 17_200_000n, profitVnd: 660_264n },
    ]);
    const b = (await r.byBatch(sql, "2026-11-05")).find((x) => x.code === "CH-2026-011")!;
    expect(b).toMatchObject({
      itemCount: 3,
      soldCount: 2,
      roiBp: 553,
      realizedProfitVnd: 2_706_128n,
      firstOrder: "2026-10-01",
      lastSale: "2026-10-27",
      soldOut: false,
      cycleDays: 35,
    });
  });

  it("vận chuyển: thời gian từng chặng, kiện Mỹ → VN nhận trễ ETA một ngày", async () => {
    const t = await r.transport(sql, OCT.from, OCT.toExcl, "2026-11-05");
    expect(t.map((x) => [x.leg, x.carrier, x.shipments, x.items, x.arrived, x.avgDays, x.late, x.hold])).toEqual([
      ["US_DOMESTIC", "USPS", 1, 3, 1, 3.2, 0, 0],
      ["US_TO_VN", "Forwarder A", 1, 3, 1, 8.3, 1, 0],
      ["HN_TO_SG", "Chành xe B", 1, 3, 1, 2.3, 0, 0],
    ]);
  });

  it("tồn kho & sổ doanh thu thuế năm 2026", async () => {
    const inv = await r.inventory(sql);
    expect(inv.items.map((i) => [i.label, i.costVnd])).toEqual([["AirPods Pro · White", 6_979_336n]]);
    expect(inv.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
    const tax = await r.taxReport(sql, 2026);
    expect(tax).toMatchObject({
      totalVnd: 51_700_000n,
      invoicedVnd: 0n,
      landedCostsVnd: 1_902_408n,
      landedCostsValidVnd: 1_752_408n,
      opexVnd: 500_000n,
      thresholdVnd: 1_000_000_000n,
      warnRatio: 0.8,
    });
    expect(tax.months).toHaveLength(12);
    expect(tax.months[9]).toMatchObject({ month: "2026-10-01", orders: 2, units: 2, revenueVnd: 51_700_000n });
    expect(tax.uninvoiced.map((u) => [u.code, u.revenueVnd])).toEqual([
      ["BH-2026-0001", 34_500_000n],
      ["BH-2026-0002", 17_200_000n],
    ]);
    await inTx(async (tx) => {
      await tx`UPDATE sales SET einvoice_no = 'HD-001' WHERE code = 'BH-2026-0001'`;
      const t2 = await r.taxReport(tx, 2026);
      expect(t2.invoicedVnd).toBe(34_500_000n);
      expect(t2.months[9]).toMatchObject({ invoicedOrders: 1, invoicedRevenueVnd: 34_500_000n });
      expect(t2.uninvoiced.map((u) => u.code)).toEqual(["BH-2026-0002"]);
    });
  });

  it("xuất Excel cho mọi báo cáo: có số liệu, tên tệp theo kỳ", async () => {
    const keys = ["lai-lo", "dong-may", "chuyen", "kenh", "van-chuyen", "ton-kho", "thue"] as const;
    for (const k of keys) {
      const { filename, sheets } = await exportReport(sql, k, OCT, "2026-11-05");
      expect(filename).toMatch(new RegExp(`^ipre-${k}-[\\d_-]+\\.xlsx$`));
      expect(sheets.length).toBeGreaterThan(0);
      const buf = buildXlsx(sheets);
      expect(buf.subarray(0, 2).toString()).toBe("PK");
    }
    const pnl = await exportReport(sql, "lai-lo", OCT, "2026-11-05");
    expect(pnl.filename).toBe("ipre-lai-lo-2026-10.xlsx");
    expect(pnl.sheets[0].rows.at(-1)).toEqual(["Lãi ròng trước thuế", 2_206_128n, 427, 0n, null]);
    expect(pnl.sheets[0].rows[1][1]).toBe(-48_963_872n); // dòng trừ ghi số âm
  });
});
