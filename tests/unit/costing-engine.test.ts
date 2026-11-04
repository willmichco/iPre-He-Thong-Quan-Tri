import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  batchSummary,
  computeAllocations,
  computeSaleLines,
  divRound,
  itemProfit,
  parseScaled,
  summarizeItemCosts,
  type Allocation,
  type CostInput,
  type CostingInput,
} from "@/domain/costing";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const totalOf = (as: Allocation[], f: (a: Allocation) => boolean = () => true) => sum(as.filter(f).map((a) => a.amountVnd));

function base(): CostingInput {
  return {
    purchaseOrders: [{ id: "po1", fxRate: "25432.5000", salesTax: "71.94", sellerShipping: "9.99", discount: "50.00", fxFeeVnd: 1_234_567n }],
    items: [
      { id: "a", batchId: "b1", purchaseOrderId: "po1", unitPrice: "999.00", weightKg: "0.5" },
      { id: "b", batchId: "b1", purchaseOrderId: "po1", unitPrice: "199.99", weightKg: "0.2" },
      { id: "c", batchId: "b1", purchaseOrderId: "po1", unitPrice: "0.01", weightKg: "0.05" },
    ],
    shipments: [{ id: "s1", itemIds: ["a", "b", "c"] }],
    costs: [],
  };
}

describe("đơn mua: thuế, ship người bán, giảm giá, phí ngoại tệ", () => {
  it("Σ thành phần đơn mua = round((Σ đơn giá + thuế + ship − giảm giá) × tỷ giá) + phí — đúng cột total_vnd của CSDL", () => {
    const { allocations } = computeAllocations(base());
    // (1199.00 + 71.94 + 9.99 − 50.00) × 25432.5 = 31.305.427,7… → 31.305.428 ; + 1.234.567
    const expected = divRound((119_900n + 7_194n + 999n - 5_000n) * 254_325_000n, 10n ** 6n) + 1_234_567n;
    expect(totalOf(allocations)).toBe(expected);
    expect(totalOf(allocations, (a) => a.component === "DISCOUNT")).toBeLessThan(0n);
    expect(allocations.filter((a) => a.component === "DISCOUNT").every((a) => a.amountVnd <= 0n)).toBe(true);
  });

  it("thuộc tính: với mọi đơn mua ngẫu nhiên, tổng khớp tuyệt đối công thức total_vnd (2.000 bộ)", () => {
    const money = fc.integer({ min: 0, max: 500_000 }).map((c) => (c / 100).toFixed(2));
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 300_000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 10_000, max: 300_000_000 }), // tỷ giá × 10⁴
        money,
        money,
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.bigInt({ min: 0n, max: 2_000_000n }),
        (prices, fx4, tax, ship, discCents, fee) => {
          const goods = prices.reduce((a, b) => a + b, 0);
          const disc = (Math.min(discCents, goods) / 100).toFixed(2);
          const fx = (fx4 / 10_000).toFixed(4);
          const input: CostingInput = {
            purchaseOrders: [{ id: "p", fxRate: fx, salesTax: tax, sellerShipping: ship, discount: disc, fxFeeVnd: fee }],
            items: prices.map((c, i) => ({ id: `i${i}`, batchId: "b", purchaseOrderId: "p", unitPrice: (c / 100).toFixed(2) })),
          };
          const cents = BigInt(goods) + parseScaled(tax, 2) + parseScaled(ship, 2) - parseScaled(disc, 2);
          const expected = divRound(cents * BigInt(fx4), 10n ** 6n) + fee;
          return totalOf(computeAllocations(input).allocations) === expected;
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("đơn toàn máy 0 đồng (quà tặng kèm): thuế/phí chia theo số lượng", () => {
    const { allocations } = computeAllocations({
      purchaseOrders: [{ id: "p", fxRate: 25000, salesTax: "3.00" }],
      items: [
        { id: "x", batchId: "b", purchaseOrderId: "p", unitPrice: 0 },
        { id: "y", batchId: "b", purchaseOrderId: "p", unitPrice: "0.00" },
      ],
    });
    expect(allocations.map((a) => [a.itemId, a.component, a.amountVnd])).toEqual([
      ["x", "SALES_TAX", 37_500n],
      ["y", "SALES_TAX", 37_500n],
    ]);
  });

  it("giá VND làm tròn về 0 (0,01 USD × tỷ giá 1) → thuế chia theo đơn giá gốc, không lỗi (fast-check tìm ra)", () => {
    const { allocations } = computeAllocations({
      purchaseOrders: [{ id: "p", fxRate: 1, salesTax: "100.00" }],
      items: [
        { id: "x", batchId: "b", purchaseOrderId: "p", unitPrice: "0.01" },
        { id: "y", batchId: "b", purchaseOrderId: "p", unitPrice: "0.03" },
      ],
    });
    expect(allocations.map((a) => [a.itemId, a.component, a.amountVnd])).toEqual([
      ["x", "SALES_TAX", 25n],
      ["y", "SALES_TAX", 75n],
    ]);
  });

  it("đơn mua có thuế nhưng chưa có máy → cảnh báo, không lỗi; đơn trống không cảnh báo", () => {
    const { allocations, warnings } = computeAllocations({
      purchaseOrders: [
        { id: "p1", fxRate: 25000, salesTax: "5" },
        { id: "p2", fxRate: 25000 },
      ],
      items: [],
    });
    expect(allocations).toEqual([]);
    expect(warnings.map((w) => [w.code, w.refs])).toEqual([["PO_WITHOUT_ITEMS", ["p1"]]]);
  });

  it("máy thuộc đơn mua không có trong dữ liệu → lỗi rõ ràng", () => {
    expect(() =>
      computeAllocations({ purchaseOrders: [], items: [{ id: "x", batchId: "b", purchaseOrderId: "zz", unitPrice: 1 }] }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_PURCHASE_ORDER", refs: ["x"] }));
  });
});

describe("chi phí: 4 phương pháp phân bổ, mọi loại đối tượng gắn", () => {
  const cost = (c: Partial<CostInput>): CostInput => ({
    id: "k",
    kind: "HANDLING",
    target: { type: "BATCH", id: "b1" },
    amountVnd: 100_000n,
    method: "BY_QUANTITY",
    ...c,
  });
  const run = (...costs: CostInput[]) => computeAllocations({ ...base(), costs }).allocations;
  const ofCost = (as: Allocation[], id = "k") => as.filter((a) => a.costId === id).map((a) => [a.itemId, a.amountVnd]);

  it("thuộc tính: Σ phân bổ của MỌI chi phí = số tiền chi phí (mọi phương pháp, số âm, 2.000 bộ)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -50_000_000n, max: 50_000_000n }).filter((x) => x !== 0n),
        fc.constantFrom("BY_QUANTITY", "BY_VALUE", "BY_WEIGHT") as fc.Arbitrary<CostInput["method"]>,
        fc.constantFrom<CostInput["target"]>({ type: "BATCH", id: "b1" }, { type: "PURCHASE_ORDER", id: "po1" }, { type: "SHIPMENT", id: "s1" }),
        (amount, method, target) => totalOf(run(cost({ amountVnd: amount, method, target })), (a) => a.costId === "k") === amount,
      ),
      { numRuns: 2000 },
    );
  });

  it("theo cân nặng: 0,5 / 0,2 / 0,05 kg", () => {
    expect(ofCost(run(cost({ method: "BY_WEIGHT", amountVnd: 750_000n })))).toEqual([
      ["a", 500_000n],
      ["b", 200_000n],
      ["c", 50_000n],
    ]);
  });

  it("theo cân nặng mà máy thiếu cân nặng → lỗi MISSING_WEIGHT chỉ đúng máy thiếu", () => {
    const input = base();
    input.items[1].weightKg = null;
    input.items[2].weightKg = "";
    input.costs = [cost({ method: "BY_WEIGHT" })];
    expect(() => computeAllocations(input)).toThrow(expect.objectContaining({ code: "MISSING_WEIGHT", refs: ["k", "b", "c"] }));
  });

  it("theo giá trị dùng GIÁ MUA QUY ĐỔI của máy (đã gồm thuế, phí của đơn)", () => {
    const as = run(cost({ method: "BY_VALUE", amountVnd: 1_000_000n }));
    const purchase = summarizeItemCosts(as, ["a", "b", "c"]).map((c) => c.purchaseVnd);
    const shares = ofCost(as).map(([, v]) => v as bigint);
    // tỷ lệ phân bổ = tỷ lệ giá mua quy đổi (chênh < 1 đồng)
    shares.forEach((s, i) => expect(Math.abs(Number(s) - (1_000_000 * Number(purchase[i])) / Number(sum(purchase)))).toBeLessThan(1));
  });

  it("thủ công: đúng số nhập; lệch tổng hoặc nhập cho máy ngoài đối tượng → lỗi", () => {
    const ok = cost({
      method: "MANUAL",
      target: { type: "SHIPMENT", id: "s1" },
      manualShares: [
        { itemId: "a", amountVnd: 70_000n },
        { itemId: "c", amountVnd: 30_000n },
      ],
    });
    expect(ofCost(run(ok))).toEqual([
      ["a", 70_000n],
      ["c", 30_000n],
    ]);
    expect(() => run({ ...ok, amountVnd: 100_001n })).toThrow(expect.objectContaining({ code: "MANUAL_SHARES_MISMATCH" }));
    expect(() => run({ ...ok, target: { type: "ITEM", id: "a" } })).toThrow(expect.objectContaining({ code: "MANUAL_SHARE_OUTSIDE_TARGET", refs: ["k", "c"] }));
    expect(() => run({ ...ok, manualShares: undefined })).toThrow(expect.objectContaining({ code: "MANUAL_SHARES_MISMATCH" }));
  });

  it("gắn vào một máy → máy đó nhận trọn; gắn vào đơn mua → các máy của đơn", () => {
    expect(ofCost(run(cost({ target: { type: "ITEM", id: "b" }, amountVnd: 12_345n })))).toEqual([["b", 12_345n]]);
    expect(ofCost(run(cost({ target: { type: "PURCHASE_ORDER", id: "po1" }, amountVnd: 3n })))).toEqual([
      ["a", 1n],
      ["b", 1n],
      ["c", 1n],
    ]);
  });

  it("hoàn phí (số âm) giảm giá vốn", () => {
    expect(ofCost(run(cost({ amountVnd: -90_000n })))).toEqual([
      ["a", -30_000n],
      ["b", -30_000n],
      ["c", -30_000n],
    ]);
  });

  it("máy đã trả người bán không nhận chi phí vận chuyển; nếu không còn máy nào → lỗi NO_TARGET_ITEMS", () => {
    const input = base();
    input.items[0].excludedFromCosts = true;
    input.costs = [cost({ amountVnd: 100_000n })];
    expect(ofCost(computeAllocations(input).allocations)).toEqual([
      ["b", 50_000n],
      ["c", 50_000n],
    ]);
    // máy trả lại vẫn giữ giá mua (khoản hoàn ghi riêng)
    expect(computeAllocations(input).allocations.some((a) => a.itemId === "a" && a.component === "PRICE")).toBe(true);
    expect(() => run(cost({ target: { type: "BATCH", id: "khong-co" } }))).toThrow(expect.objectContaining({ code: "NO_TARGET_ITEMS" }));
    // chi phí gắn THẲNG vào máy đã trả (vd. phí gửi trả) vẫn tính cho chính máy đó
    input.costs = [cost({ target: { type: "ITEM", id: "a" }, amountVnd: 40_000n })];
    expect(ofCost(computeAllocations(input).allocations)).toEqual([["a", 40_000n]]);
  });

  it("kiện/máy không có trong dữ liệu tính → lỗi; kiện gom máy của chuyến khác chưa nạp → lỗi rõ ràng", () => {
    expect(() => run(cost({ target: { type: "SHIPMENT", id: "zz" } }))).toThrow(expect.objectContaining({ code: "UNKNOWN_SHIPMENT" }));
    expect(() => run(cost({ target: { type: "ITEM", id: "zz" } }))).toThrow(expect.objectContaining({ code: "UNKNOWN_ITEM" }));
    const input = base();
    input.shipments = [{ id: "s1", itemIds: ["a", "may-chuyen-khac"] }];
    input.costs = [cost({ target: { type: "SHIPMENT", id: "s1" } })];
    expect(() => computeAllocations(input)).toThrow(expect.objectContaining({ code: "UNKNOWN_ITEM", refs: ["s1", "may-chuyen-khac"] }));
  });

  it("theo giá trị khi các máy chưa có giá mua → lỗi ZERO_WEIGHT", () => {
    expect(() =>
      computeAllocations({
        purchaseOrders: [{ id: "p", fxRate: 1 }],
        items: [{ id: "x", batchId: "b", purchaseOrderId: "p", unitPrice: 0 }],
        costs: [cost({ target: { type: "BATCH", id: "b" }, method: "BY_VALUE" })],
      }),
    ).toThrow(expect.objectContaining({ code: "ZERO_WEIGHT" }));
  });

  it("chi phí dự toán → máy mang cờ hasEstimate (lãi hiển thị 'Tạm tính'); chi phí 0 đồng không sinh dòng", () => {
    const as = run(cost({ isEstimate: true, target: { type: "ITEM", id: "c" }, amountVnd: 5_000n, kind: "OTHER_LANDED" }));
    const sumry = summarizeItemCosts(as, ["a", "c", "khong-co"]);
    expect(sumry.map((s) => s.hasEstimate)).toEqual([false, true, false]);
    expect(sumry[1].otherVnd).toBe(5_000n);
    expect(sumry[2].landedCostVnd).toBe(0n);
    expect(as.every((a) => a.amountVnd !== 0n)).toBe(true);
  });
});

describe("bán hàng & lãi lỗ", () => {
  it("giảm giá và chi phí bán của đơn chia theo giá bán; khớp tuyệt đối", () => {
    const lines = computeSaleLines({
      discountVnd: 100_000n,
      expensesVnd: [30_000n, 20_001n],
      lines: [
        { itemId: "a", priceVnd: 30_000_000n },
        { itemId: "b", priceVnd: 10_000_000n },
      ],
    });
    expect(lines.map((l) => [l.discountAllocVnd, l.expenseAllocVnd, l.netRevenueVnd])).toEqual([
      [75_000n, 37_501n, 29_925_000n],
      [25_000n, 12_500n, 9_975_000n],
    ]);
    expect(computeSaleLines({ lines: [] })).toEqual([]);
  });

  it("đơn bán 0 đồng (tặng): chi phí bán chia đều; biên lãi không xác định", () => {
    const [l1, l2] = computeSaleLines({ expensesVnd: [10_000n], lines: [{ itemId: "a", priceVnd: 0n }, { itemId: "b", priceVnd: 0n }] });
    expect([l1.expenseAllocVnd, l2.expenseAllocVnd]).toEqual([5_000n, 5_000n]);
    expect(itemProfit(l1, 1_000_000n)).toMatchObject({ profitVnd: -1_005_000n, marginBp: null });
  });

  it("bán lỗ cho biên lãi âm; máy loại bỏ (thất lạc/hỏng) không tính vào vốn đọng", () => {
    const [l] = computeSaleLines({ lines: [{ itemId: "a", priceVnd: 9_000_000n }] });
    expect(itemProfit(l, 10_000_000n)).toMatchObject({ grossProfitVnd: -1_000_000n, marginBp: -1111 });
    const s = batchSummary([
      { itemId: "a", costVnd: 10_000_000n, sale: l },
      { itemId: "b", costVnd: 5_000_000n, writtenOff: true },
      { itemId: "c", costVnd: 7_000_000n },
    ]);
    expect(s).toMatchObject({ realizedProfitVnd: -1_000_000n, tiedCapitalVnd: 7_000_000n, writtenOffCostVnd: 5_000_000n, roiOnSoldBp: -1000 });
    expect(batchSummary([]).roiOnSoldBp).toBeNull();
  });
});
