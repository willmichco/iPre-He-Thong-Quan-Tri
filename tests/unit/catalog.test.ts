import { describe, expect, it } from "vitest";
import {
  accountSchema,
  carrierSchema,
  checkVariantCode,
  classifyCodeType,
  modelSchema,
  parseDecimalInput,
  suggestSku,
  supplierSchema,
  validate,
  variantLabel,
  variantSchema,
} from "@/domain/catalog";

describe("đọc số kiểu Việt Nam", () => {
  it.each([
    ["0,6", 3, "0.600"],
    ["0.6", 3, "0.600"],
    ["1,2", 2, "1.20"],
    ["1.199,00", 2, "1199.00"],
    ["1,199.00", 2, "1199.00"],
    ["$1,199", 2, "1199.00"],
    ["1.199", 2, "1199.00"],
    ["1.199", 3, "1.199"], // cân nặng: 1,199 kg
    ["1.234.567", 0, "1234567"],
    ["26.400", 0, "26400"],
    ["26400,5", 4, "26400.5000"],
    ["0,600", 2, null], // quá 2 chữ số thập phân
    ["007", 0, "7"],
    ["-5", 2, "-5.00"],
    [" 30 ₫ ", 0, "30"],
  ] as const)("%s (scale %d) → %s", (raw, scale, out) => {
    expect(parseDecimalInput(raw, scale)).toBe(out);
  });
  it.each(["", "abc", "1,2,3a", "1.2.3,4.5", "--1"])("không phải số: %s", (raw) => {
    expect(parseDecimalInput(raw, 2)).toBeNull();
  });
});

describe("gợi ý SKU", () => {
  it.each([
    ["iPhone Pro Max", { storage: "256GB", color: "Silver" }, "IPPM-256-SLV"],
    ["iPad Air 11", { storage: "128GB", color: "Blue" }, "IPADAIR11-128-BLU"],
    ["AirPods Pro", {}, "APP-STD"],
    ["MacBook Pro 14", { chip: "M4 Pro", memory: "24GB", storage: "1TB", color: "Space Black" }, "MBP14-M4PRO-24-1T-SB"],
    ["iPhone 17", { storage: "512 GB", color: "Trắng" }, "IP17-512-TRN"],
    ["Apple Watch Ultra 3", { color: "Natural Titanium" }, "AWU3-NT"],
    ["Ốp lưng", {}, "OPLUN-STD"],
    ["!!!", {}, "SP-STD"],
  ] as const)("%s %o → %s", (model, v, sku) => {
    expect(suggestSku(model, v)).toBe(sku);
  });
});

describe("mã trên hộp", () => {
  it("Part No.: in hoa, bỏ tiền tố 1P, tách thị trường", () => {
    expect(checkVariantCode("PART_NUMBER", " mdem1ll/a ")).toEqual({ ok: true, code: "MDEM1LL/A", region: "LL/A" });
    expect(checkVariantCode("PART_NUMBER", "1PMYMJ3VN/A")).toEqual({ ok: true, code: "MYMJ3VN/A", region: "VN/A" });
    expect(checkVariantCode("PART_NUMBER", "350000000000006")).toMatchObject({ ok: false });
  });
  it("UPC / EAN kiểm số kiểm tra", () => {
    expect(checkVariantCode("UPC", "012345678905")).toEqual({ ok: true, code: "012345678905", region: null });
    expect(checkVariantCode("UPC", "012345678906")).toMatchObject({ ok: false, error: expect.stringContaining("12 số") });
    expect(checkVariantCode("EAN", "4006381333931")).toMatchObject({ ok: true });
    expect(checkVariantCode("EAN", "4006381333932")).toMatchObject({ ok: false, error: expect.stringContaining("13 số") });
  });
  it("đoán loại mã", () => {
    expect(classifyCodeType("mdem1ll/a")).toBe("PART_NUMBER");
    expect(classifyCodeType("1PMDEM1LL/A")).toBe("PART_NUMBER");
    expect(classifyCodeType("012345678905")).toBe("UPC");
    expect(classifyCodeType("4006381333931")).toBe("EAN");
    expect(classifyCodeType("F2LXQ7Y9KD")).toBeNull();
  });
});

describe("kiểm tra form", () => {
  const variant = {
    modelId: "10000000-0000-0000-0000-000000000001",
    sku: "",
    storage: "256GB",
    color: "",
    chip: "",
    memory: "",
    connectivity: "",
    defaultWeightKg: "0,6",
  };

  it("cấu hình: ô trống → null, cân nặng dấu phẩy, SKU in hoa", () => {
    expect(validate(variantSchema, { ...variant, sku: "ip pm 256", isActive: "on" })).toEqual({
      ok: true,
      data: { ...variant, sku: "IP-PM-256", color: null, chip: null, memory: null, connectivity: null, defaultWeightKg: "0.600", isActive: true },
    });
    expect(validate(variantSchema, { ...variant, isActive: "" })).toMatchObject({ ok: true, data: { sku: null, isActive: false } });
  });
  it("cấu hình: cân nặng âm / quá 3 số lẻ / chữ → lỗi đúng ô", () => {
    for (const w of ["-1", "0", "0,1234", "nặng"])
      expect(validate(variantSchema, { ...variant, defaultWeightKg: w })).toEqual({
        ok: false,
        errors: { defaultWeightKg: expect.stringContaining("Cân nặng") },
      });
    expect(validate(variantSchema, { ...variant, modelId: "x" })).toEqual({ ok: false, errors: { modelId: "Chọn mẫu máy" } });
  });
  it("mẫu máy", () => {
    expect(validate(modelSchema, { category: "IPHONE", name: "  iPhone 17  ", releaseYear: "" })).toEqual({
      ok: true,
      data: { category: "IPHONE", name: "iPhone 17", releaseYear: null },
    });
    expect(validate(modelSchema, { category: "PHONE", name: "", releaseYear: "1999" })).toEqual({
      ok: false,
      errors: { category: "Chọn dòng sản phẩm", name: "Nhập tên mẫu máy", releaseYear: expect.stringContaining("2007") },
    });
  });
  it("nơi mua: bang 2 chữ cái in hoa", () => {
    expect(validate(supplierSchema, { name: "Costco", kind: "RETAILER", usState: "wa", returnDays: "90", note: "" })).toMatchObject({
      ok: true,
      data: { usState: "WA", returnDays: 90, note: null },
    });
    expect(validate(supplierSchema, { name: "X", usState: "W1", returnDays: "", note: "" })).toEqual({
      ok: false,
      errors: { usState: expect.stringContaining("2 chữ cái") },
    });
  });
  it("đơn vị vận chuyển: phải chọn chặng; mẫu link phải có {tracking}", () => {
    const base = { name: "USPS", legTypes: ["US_DOMESTIC"], trackingUrlTemplate: "", defaultLeadDays: "4", contact: "", note: "" };
    expect(validate(carrierSchema, base)).toMatchObject({ ok: true, data: { trackingUrlTemplate: null, defaultLeadDays: 4 } });
    expect(validate(carrierSchema, { ...base, legTypes: [] })).toEqual({ ok: false, errors: { legTypes: "Chọn ít nhất một chặng" } });
    expect(validate(carrierSchema, { ...base, trackingUrlTemplate: "https://tools.usps.com/go/TrackConfirmAction?tLabels=" })).toEqual({
      ok: false,
      errors: { trackingUrlTemplate: expect.stringContaining("{tracking}") },
    });
    expect(validate(carrierSchema, { ...base, trackingUrlTemplate: "https://x.test/t?n={tracking}" })).toMatchObject({ ok: true });
  });
  it("tài khoản: số dư đầu kỳ mặc định 0", () => {
    expect(validate(accountSchema, { name: "Tiền mặt", kind: "CASH", openingBalance: "", isActive: "on" })).toEqual({
      ok: true,
      data: { name: "Tiền mặt", currency: "VND", kind: "CASH", openingBalance: "0.00", isActive: true },
    });
    expect(validate(accountSchema, { name: "VCB", kind: "BANK", openingBalance: "12.500.000", isActive: "" })).toMatchObject({
      ok: true,
      data: { openingBalance: "12500000.00", isActive: false },
    });
  });
  it("tên hiển thị cấu hình", () => {
    expect(variantLabel("MacBook Pro 14", { chip: "M4 Pro", memory: "24GB", storage: "1TB", color: "Space Black" })).toBe(
      "MacBook Pro 14 · M4 Pro · 24GB · 1TB · Space Black",
    );
  });
});
