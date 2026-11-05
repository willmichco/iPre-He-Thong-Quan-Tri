import { describe, expect, it } from "vitest";
import {
  balanceOf,
  centsToDecimal,
  checkManualEntry,
  checkTransfer,
  daysBetween,
  debtAgeBucket,
  deletableSource,
  editableSource,
  fillWeeks,
  formatAmount,
  isManualCategory,
  lastWeeks,
  parseAmount,
  parseBalance,
  parseRate,
  reconcileDiff,
  runningBalances,
  sourceOf,
  toCents,
  transferLegs,
  vndFromUsdCents,
  weekStart,
} from "@/domain/ledger";

const ACC = "50000000-0000-0000-0000-000000000001";
const ACC2 = "50000000-0000-0000-0000-000000000002";

describe("Tiền (xu)", () => {
  it("numeric ↔ xu, không lệch số thực", () => {
    expect(toCents("54040800.00")).toBe(5_404_080_000n);
    expect(toCents("0.1")).toBe(10n);
    expect(toCents("-5")).toBe(-500n);
    expect(toCents("1234.5")).toBe(123_450n);
    expect(() => toCents("1.234")).toThrow();
    expect(centsToDecimal(123_450n)).toBe("1234.50");
    expect(centsToDecimal(-7n)).toBe("-0.07");
    expect(centsToDecimal(0n)).toBe("0.00");
  });

  it("số tiền gõ tay theo tiền tệ tài khoản", () => {
    expect(parseAmount("2tr", "VND")).toBe(200_000_000n);
    expect(parseAmount("500k", "VND")).toBe(50_000_000n);
    expect(parseAmount("2.000.000", "VND")).toBe(200_000_000n);
    expect(parseAmount("0", "VND")).toBeNull();
    expect(parseAmount("abc", "VND")).toBeNull();
    expect(parseAmount("$1,199.00", "USD")).toBe(119_900n);
    expect(parseAmount("1.199,50", "USD")).toBe(119_950n);
    expect(parseAmount("20", "USD")).toBe(2_000n);
    expect(parseAmount("-5", "USD")).toBeNull();
  });

  it("số dư sao kê: được âm / 0; VND chấp nhận đuôi ,00", () => {
    expect(parseBalance("12.500.000", "VND")).toBe(1_250_000_000n);
    expect(parseBalance("12.500.000,00", "VND")).toBe(1_250_000_000n);
    expect(parseBalance("-54.568.800", "VND")).toBe(-5_456_880_000n);
    expect(parseBalance("−1tr", "VND")).toBe(-100_000_000n);
    expect(parseBalance("0", "VND")).toBe(0n);
    expect(parseBalance("1,250.75", "USD")).toBe(125_075n);
    expect(parseBalance("", "VND")).toBeNull();
    expect(parseBalance("x", "USD")).toBeNull();
  });

  it("tỷ giá & quy đổi USD → VND làm tròn nửa xa số 0", () => {
    expect(parseRate("26.350")).toBe("26350.0000");
    expect(parseRate("0")).toBeNull();
    expect(vndFromUsdCents(2_000n, "26400")).toBe(528_000n);
    expect(vndFromUsdCents(1n, "26350.5")).toBe(264n); // 263,505 → 264
    expect(vndFromUsdCents(-1n, "26350.5")).toBe(-264n);
  });

  it("hiển thị: VND không lẻ, USD 2 số lẻ, âm có dấu −", () => {
    expect(formatAmount(5_404_080_000n, "VND")).toBe("54.040.800 ₫");
    expect(formatAmount(-100n, "VND")).toBe("−1 ₫");
    expect(formatAmount(150n, "VND")).toBe("1,50 ₫");
    expect(formatAmount(119_950n, "USD")).toBe("1.199,50 $");
  });
});

describe("Số dư, đối soát", () => {
  const txns = [
    { direction: "IN" as const, amountCents: 1000n },
    { direction: "OUT" as const, amountCents: 300n },
    { direction: "OUT" as const, amountCents: 900n },
  ];
  it("số dư = đầu kỳ + Σ thu − Σ chi; luỹ kế từng dòng", () => {
    expect(balanceOf(500n, txns)).toBe(300n);
    expect(runningBalances(500n, txns)).toEqual([1500n, 1200n, 300n]);
    expect(balanceOf(0n, [])).toBe(0n);
  });
  it("chênh lệch đối soát và chiều bút toán điều chỉnh", () => {
    expect(reconcileDiff(1000n, 1000n)).toEqual({ diff: 0n, direction: null, amount: 0n });
    expect(reconcileDiff(900n, 1000n)).toEqual({ diff: -100n, direction: "OUT", amount: 100n });
    expect(reconcileDiff(1200n, 1000n)).toEqual({ diff: 200n, direction: "IN", amount: 200n });
  });
});

describe("Nguồn bút toán", () => {
  it("nhận diện chứng từ gốc; chỉ nhập tay mới sửa được", () => {
    expect(sourceOf({ purchaseOrderId: "x", categoryCode: "PURCHASE" })).toBe("PURCHASE_ORDER");
    expect(sourceOf({ costId: "x", categoryCode: "LANDED_COST" })).toBe("COST");
    expect(sourceOf({ saleId: "x", saleExpenseId: "y", categoryCode: "SALE_EXPENSE" })).toBe("SALE_EXPENSE");
    expect(sourceOf({ saleId: "x", categoryCode: "SALE_RECEIPT" })).toBe("SALE");
    expect(sourceOf({ transferGroupId: "g", categoryCode: "TRANSFER_IN" })).toBe("TRANSFER");
    expect(sourceOf({ categoryCode: "ADJUST_OUT" })).toBe("ADJUSTMENT");
    expect(sourceOf({ categoryCode: "OPEX_ADS" })).toBe("MANUAL");
    expect(editableSource("MANUAL")).toBe(true);
    expect(editableSource("TRANSFER")).toBe(false);
    expect(deletableSource("TRANSFER")).toBe(true);
    expect(deletableSource("SALE")).toBe(false);
  });
  it("danh mục nhập tay: tự tạo + góp/rút vốn + thuế; không cho danh mục tự sinh", () => {
    expect(isManualCategory({ code: "OPEX_ADS", isSystem: false })).toBe(true);
    expect(isManualCategory({ code: "CAPITAL_IN", isSystem: true })).toBe(true);
    expect(isManualCategory({ code: "TAX", isSystem: true })).toBe(true);
    expect(isManualCategory({ code: "PURCHASE", isSystem: true })).toBe(false);
    expect(isManualCategory({ code: "TRANSFER_IN", isSystem: true })).toBe(false);
  });
});

describe("Dòng tiền theo tuần, tuổi nợ", () => {
  it("tuần bắt đầu thứ Hai", () => {
    expect(weekStart("2026-11-05")).toBe("2026-11-02"); // thứ Năm
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02"); // Chủ nhật
    expect(weekStart("2026-01-01")).toBe("2025-12-29");
  });
  it("12 tuần gần nhất, điền 0 tuần trống", () => {
    const w = lastWeeks("2026-11-05", 3);
    expect(w).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
    const f = fillWeeks([{ week: "2026-10-26", inVnd: 5n, outVnd: 2n }], w);
    expect(f.map((x) => [x.label, x.inVnd, x.outVnd])).toEqual([
      ["19/10", 0n, 0n],
      ["26/10", 5n, 2n],
      ["02/11", 0n, 0n],
    ]);
  });
  it("số ngày và nhóm tuổi nợ", () => {
    expect(daysBetween("2026-10-01", "2026-11-05")).toBe(35);
    expect(daysBetween("2026-12-01", "2026-11-05")).toBe(0);
    expect([0, 30, 31, 60, 61, 90, 91].map(debtAgeBucket)).toEqual(["0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "90+"]);
  });
});

describe("Kiểm tra form", () => {
  it("bút toán nhập tay", () => {
    const ok = checkManualEntry({ accountId: ACC, categoryCode: "OPEX_ADS", amount: " 2tr ", occurredAt: "2026-11-05", fxRate: "", note: " " });
    expect(ok).toEqual({
      ok: true,
      data: { accountId: ACC, categoryCode: "OPEX_ADS", amount: "2tr", fxRate: null, occurredAt: "2026-11-05", counterparty: null, note: null },
    });
    const bad = checkManualEntry({ accountId: "x", amount: "", occurredAt: "05/11", fxRate: "abc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["accountId", "amount", "categoryCode", "fxRate", "occurredAt"]);
    expect(checkManualEntry({ accountId: ACC, categoryCode: "X", amount: "1", occurredAt: "2026-11-05", note: "x".repeat(501) }).ok).toBe(false);
  });
  it("chuyển tiền: hai tài khoản khác nhau", () => {
    expect(checkTransfer({ fromAccountId: ACC, toAccountId: ACC, amountFrom: "1tr", occurredAt: "2026-11-05" })).toMatchObject({
      ok: false,
      errors: { toAccountId: expect.stringContaining("khác") },
    });
    expect(checkTransfer({ fromAccountId: ACC, toAccountId: ACC2, amountFrom: "1tr", occurredAt: "2026-11-05", fxRate: "26.400" })).toMatchObject({
      ok: true,
      data: { amountTo: null, fxRate: "26400.0000", note: null },
    });
    const bad = checkTransfer({});
    expect(bad.ok).toBe(false);
  });
  it("hai vế chuyển tiền / đổi ngoại tệ", () => {
    const vnd = { currency: "VND" as const };
    const usd = { currency: "USD" as const };
    expect(transferLegs(vnd, vnd, { amountFrom: "10tr", amountTo: "9tr", fxRate: null })).toEqual({
      ok: true,
      outCents: 1_000_000_000n,
      inCents: 1_000_000_000n, // cùng tiền tệ: hai vế bằng nhau
      vnd: 10_000_000n,
    });
    expect(transferLegs(vnd, usd, { amountFrom: "26.400.000", amountTo: "1,000.00", fxRate: null })).toEqual({
      ok: true,
      outCents: 2_640_000_000n,
      inCents: 100_000n,
      vnd: 26_400_000n,
    });
    expect(transferLegs(usd, vnd, { amountFrom: "100", amountTo: "2.630.000", fxRate: null })).toMatchObject({ ok: true, vnd: 2_630_000n });
    expect(transferLegs(usd, usd, { amountFrom: "100", amountTo: null, fxRate: "26400" })).toMatchObject({ ok: true, vnd: 2_640_000n });
    expect(transferLegs(usd, usd, { amountFrom: "100", amountTo: null, fxRate: null })).toMatchObject({ ok: false, errors: { fxRate: expect.any(String) } });
    expect(transferLegs(vnd, usd, { amountFrom: "1tr", amountTo: null, fxRate: null })).toMatchObject({ ok: false, errors: { amountTo: expect.any(String) } });
    expect(transferLegs(vnd, usd, { amountFrom: "1tr", amountTo: "x", fxRate: null })).toMatchObject({ ok: false, errors: { amountTo: expect.any(String) } });
    expect(transferLegs(vnd, vnd, { amountFrom: "0", amountTo: null, fxRate: null })).toMatchObject({ ok: false, errors: { amountFrom: expect.any(String) } });
    expect(transferLegs(usd, usd, { amountFrom: "0.01", amountTo: null, fxRate: "1" })).toMatchObject({ ok: false });
  });
});
