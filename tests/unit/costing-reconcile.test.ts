/**
 * ĐỐI CHIẾU — ví dụ chuyến CH-2026-011 ở tài liệu 01, mục 6.1 (cũng là dữ liệu db/seed-vi-du.sql).
 * Engine phải ra ĐÚNG TỪNG ĐỒNG như bảng tính tay: sai lệch = 0.
 */
import { describe, expect, it } from "vitest";
import { batchSummary, computeAllocations, computeSaleLines, itemProfit, summarizeItemCosts, toVnd, type CostingInput } from "@/domain/costing";

const IPHONE = "80000000-0000-0000-0000-000000000001";
const IPAD = "80000000-0000-0000-0000-000000000002";
const AIRPODS = "80000000-0000-0000-0000-000000000003";
const BATCH = "60000000-0000-0000-0000-000000000001";
const PO = "70000000-0000-0000-0000-000000000001";

const input: CostingInput = {
  purchaseOrders: [{ id: PO, fxRate: "26400.0000" }],
  items: [
    { id: IPHONE, batchId: BATCH, purchaseOrderId: PO, unitPrice: "1199.00", weightKg: "0.600" },
    { id: IPAD, batchId: BATCH, purchaseOrderId: PO, unitPrice: "599.00", weightKg: "0.900" },
    { id: AIRPODS, batchId: BATCH, purchaseOrderId: PO, unitPrice: "249.00", weightKg: "0.300" },
  ],
  shipments: [
    { id: "ship-us", itemIds: [IPHONE, IPAD, AIRPODS] },
    { id: "ship-intl", itemIds: [IPHONE, IPAD, AIRPODS] },
    { id: "ship-hnsg", itemIds: [IPHONE, IPAD, AIRPODS] },
  ],
  costs: [
    { id: "c-us", kind: "US_DOMESTIC_SHIPPING", target: { type: "SHIPMENT", id: "ship-us" }, amountVnd: toVnd("20.00", "26400"), method: "BY_QUANTITY" },
    { id: "c-intl", kind: "INTL_SHIPPING", target: { type: "SHIPMENT", id: "ship-intl" }, amountVnd: 684_000n, method: "BY_WEIGHT" },
    { id: "c-ins", kind: "INSURANCE", target: { type: "SHIPMENT", id: "ship-intl" }, amountVnd: 540_408n, method: "BY_VALUE" },
    { id: "c-hnsg", kind: "DOMESTIC_SHIPPING", target: { type: "SHIPMENT", id: "ship-hnsg" }, amountVnd: 150_000n, method: "BY_QUANTITY" },
  ],
};

describe("đối chiếu chuyến CH-2026-011 (tài liệu 01, mục 6.1) — sai lệch 0 đồng", () => {
  const { allocations, warnings } = computeAllocations(input);
  const costs = summarizeItemCosts(allocations, [IPHONE, IPAD, AIRPODS]);

  it("từng dòng phân bổ khớp db/seed-vi-du.sql", () => {
    expect(warnings).toEqual([]);
    const rows = allocations.map((a) => [a.itemId.slice(-1), a.component, a.costId, a.amountVnd]);
    expect(rows).toEqual([
      ["1", "PRICE", null, 31_653_600n],
      ["2", "PRICE", null, 15_813_600n],
      ["3", "PRICE", null, 6_573_600n],
      ["1", "US_DOMESTIC_SHIPPING", "c-us", 176_000n],
      ["2", "US_DOMESTIC_SHIPPING", "c-us", 176_000n],
      ["3", "US_DOMESTIC_SHIPPING", "c-us", 176_000n],
      ["1", "INTL_SHIPPING", "c-intl", 228_000n],
      ["2", "INTL_SHIPPING", "c-intl", 342_000n],
      ["3", "INTL_SHIPPING", "c-intl", 114_000n],
      ["1", "INSURANCE", "c-ins", 316_536n],
      ["2", "INSURANCE", "c-ins", 158_136n],
      ["3", "INSURANCE", "c-ins", 65_736n],
      ["1", "DOMESTIC_SHIPPING", "c-hnsg", 50_000n],
      ["2", "DOMESTIC_SHIPPING", "c-hnsg", 50_000n],
      ["3", "DOMESTIC_SHIPPING", "c-hnsg", 50_000n],
    ]);
  });

  it("giá vốn về tay từng máy và tổng chuyến = 55.943.208 đ", () => {
    expect(costs.map((c) => c.landedCostVnd)).toEqual([32_424_136n, 16_539_736n, 6_979_336n]);
    expect(costs[0]).toMatchObject({ purchaseVnd: 31_653_600n, usDomesticVnd: 176_000n, internationalVnd: 544_536n, hnSgVnd: 50_000n, otherVnd: 0n, hasEstimate: false });
    expect(costs.reduce((a, c) => a + c.landedCostVnd, 0n)).toBe(55_943_208n);
  });

  it("lãi từng máy, lãi chuyến 2.706.128 đ, ROI 5,53%, vốn đọng 6.979.336 đ", () => {
    const [iphoneSale] = computeSaleLines({ expensesVnd: [30_000n], lines: [{ itemId: IPHONE, priceVnd: 34_500_000n }] });
    const [ipadSale] = computeSaleLines({ lines: [{ itemId: IPAD, priceVnd: 17_200_000n }] });
    const p1 = itemProfit(iphoneSale, costs[0].landedCostVnd);
    const p2 = itemProfit(ipadSale, costs[1].landedCostVnd);
    expect([p1.profitVnd, p1.marginBp]).toEqual([2_045_864n, 593]);
    expect([p2.profitVnd, p2.marginBp]).toEqual([660_264n, 384]);

    const s = batchSummary([
      { itemId: IPHONE, costVnd: costs[0].landedCostVnd, sale: iphoneSale },
      { itemId: IPAD, costVnd: costs[1].landedCostVnd, sale: ipadSale },
      { itemId: AIRPODS, costVnd: costs[2].landedCostVnd },
    ]);
    expect(s).toMatchObject({
      totalLandedCostVnd: 55_943_208n,
      realizedProfitVnd: 2_706_128n,
      roiOnSoldBp: 553,
      tiedCapitalVnd: 6_979_336n,
      soldCount: 2,
      unsoldCount: 1,
    });
  });
});
