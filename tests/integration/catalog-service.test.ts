/**
 * Kiểm thử tích hợp dịch vụ danh mục với PostgreSQL thật (đã nạp db/seed-vi-du.sql).
 * Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { validate, variantSchema, type VariantInput } from "@/domain/catalog";
import * as catalog from "@/server/catalog/service";
import { reopenBatchCosts } from "@/server/costing/service";

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

const CH011 = "60000000-0000-0000-0000-000000000001";
const MODEL_IPHONE = "10000000-0000-0000-0000-000000000001";
const VARIANT_IPHONE = "20000000-0000-0000-0000-000000000001";
const VARIANT_IPAD = "20000000-0000-0000-0000-000000000002";
const IPHONE_ITEM = "80000000-0000-0000-0000-000000000001";

function variantInput(over: Record<string, string>): VariantInput {
  const r = validate(variantSchema, {
    modelId: MODEL_IPHONE,
    sku: "",
    storage: "",
    color: "",
    chip: "",
    memory: "",
    connectivity: "",
    defaultWeightKg: "",
    isActive: "on",
    ...over,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
const intl = async (tx: TransactionSql, item: string) =>
  (await tx<{ v: string }[]>`SELECT amount_vnd::text AS v FROM item_cost_allocations WHERE item_id = ${item} AND component = 'INTL_SHIPPING'`)[0]?.v;

describe("dịch vụ danh mục ↔ PostgreSQL", () => {
  it("đọc danh mục ví dụ: mẫu máy → cấu hình → mã Part No., số máy đang dùng", async () => {
    const models = await catalog.listModels(sql);
    const iphone = models.find((m) => m.id === MODEL_IPHONE)!;
    expect(iphone.variants).toEqual([
      expect.objectContaining({
        sku: "IPPM-256-SLV",
        label: "iPhone Pro Max · 256GB · Silver",
        defaultWeightKg: "0.600",
        itemCount: 1,
        codes: [{ codeType: "PART_NUMBER", code: "MDEM1LL/A", region: "LL/A" }],
      }),
    ]);
    expect(await catalog.lookupCodes(sql, ["mdem1ll/a", "MDEM3AM/A", "KHONGCO"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MDEM1LL/A", sku: "IPPM-256-SLV", label: "iPhone Pro Max · 256GB · Silver" }),
        expect.objectContaining({ code: "MDEM3AM/A", region: "AM/A" }),
      ]),
    );
    expect(await catalog.lookupCodes(sql, [])).toEqual([]);
  });

  it("thêm mẫu máy → cấu hình (SKU tự gợi ý, chống trùng) → gán mã; trùng → lỗi tiếng Việt; có nhật ký", async () => {
    await inTx(async (tx) => {
      const id = await catalog.createModel(tx, { category: "IPHONE", name: "iPhone 17 Pro", releaseYear: 2025 });
      await expect(catalog.createModel(tx, { category: "IPHONE", name: "iPhone 17 Pro", releaseYear: null })).rejects.toMatchObject({
        code: "DUPLICATE",
        field: "name",
      });
      const a = await catalog.createVariant(tx, variantInput({ modelId: id, storage: "256GB", color: "Silver", defaultWeightKg: "0,6" }));
      const b = await catalog.createVariant(tx, variantInput({ modelId: id, storage: "256GB", color: "Silver" }));
      expect([a.sku, b.sku]).toEqual(["IP17P-256-SLV", "IP17P-256-SLV-2"]);
      await expect(catalog.createVariant(tx, variantInput({ modelId: id, sku: "IPPM-256-SLV" }))).rejects.toMatchObject({ code: "DUPLICATE", field: "sku" });

      expect(await catalog.addVariantCode(tx, { variantId: a.id, codeType: "PART_NUMBER", code: "1pmg8h4ll/a" })).toEqual({
        codeType: "PART_NUMBER",
        code: "MG8H4LL/A",
        region: "LL/A",
      });
      await expect(catalog.addVariantCode(tx, { variantId: b.id, codeType: "PART_NUMBER", code: "MDEM1LL/A" })).rejects.toMatchObject({
        code: "DUPLICATE",
        message: expect.stringContaining("iPhone Pro Max · 256GB · Silver"),
      });
      await expect(catalog.addVariantCode(tx, { variantId: b.id, codeType: "UPC", code: "123" })).rejects.toMatchObject({
        code: "INVALID_CODE",
        field: "code",
      });
      expect((await catalog.lookupCodes(tx, ["MG8H4LL/A"]))[0]).toMatchObject({ variantId: a.id, defaultWeightKg: "0.600" });

      // xoá: mẫu còn cấu hình → chặn; cấu hình chưa dùng → xoá luôn cả mã
      await expect(catalog.deleteModel(tx, id)).rejects.toMatchObject({ code: "IN_USE" });
      await catalog.deleteVariant(tx, a.id);
      await catalog.deleteVariant(tx, b.id);
      expect(await catalog.lookupCodes(tx, ["MG8H4LL/A"])).toEqual([]);
      await catalog.deleteModel(tx, id);

      const logs = await tx<{ action: string; entity_type: string }[]>`
        -- chỉ các dòng của transaction này (now() = thời điểm bắt đầu transaction)
        SELECT action, entity_type FROM audit_logs WHERE entity_type IN ('product_model','product_variant','variant_code') AND occurred_at = now() ORDER BY id`;
      expect(logs.map((l) => `${l.action}:${l.entity_type}`)).toEqual([
        "CREATE:product_model",
        "CREATE:product_variant",
        "CREATE:product_variant",
        "CREATE:variant_code",
        "DELETE:product_variant",
        "DELETE:product_variant",
        "DELETE:product_model",
      ]);
    });
  });

  it("cấu hình đã có máy: không xoá được; mã đổi được, bỏ mã được", async () => {
    await inTx(async (tx) => {
      await expect(catalog.deleteVariant(tx, VARIANT_IPHONE)).rejects.toMatchObject({ code: "IN_USE", message: expect.stringContaining("1 máy") });
      await catalog.deleteVariantCode(tx, "PART_NUMBER", "MDEM1LL/A");
      expect(await catalog.lookupCodes(tx, ["MDEM1LL/A"])).toEqual([]);
      await expect(catalog.deleteVariantCode(tx, "PART_NUMBER", "MDEM1LL/A")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  it("đổi cân nặng mặc định: chuyến đã chốt → chặn (không lưu); mở lại → giá vốn chia cước tự tính lại", async () => {
    await inTx(async (tx) => {
      const heavier = variantInput({ sku: "IPPM-256-SLV", storage: "256GB", color: "Silver", defaultWeightKg: "0,9" });
      await expect(catalog.updateVariant(tx, VARIANT_IPHONE, heavier)).rejects.toMatchObject({ code: "BATCH_FINALIZED" });
      const [w] = await tx<{ w: string }[]>`SELECT default_weight_kg::text AS w FROM product_variants WHERE id = ${VARIANT_IPHONE}`;
      expect(w.w).toBe("0.600");

      // đổi tên/màu mà không đổi cân nặng → không cần tính lại, chuyến đã chốt vẫn sửa được
      expect(await catalog.updateVariant(tx, VARIANT_IPHONE, { ...heavier, defaultWeightKg: "0.600", color: "Silver (Bạc)" })).toBeNull();

      await reopenBatchCosts(tx, CH011, "Cân lại iPhone thực tế 0,9 kg");
      const r = await catalog.updateVariant(tx, VARIANT_IPHONE, heavier);
      expect(r?.batches).toEqual([expect.objectContaining({ code: "CH-2026-011", updated: 3 })]);
      // cước 684.000 theo cân nặng 0,9 / 0,9 / 0,3 kg
      expect(await intl(tx, IPHONE_ITEM)).toBe("293143");
    });
  });

  it("cân nặng riêng của máy được ưu tiên: đổi mặc định không ảnh hưởng máy đã cân riêng", async () => {
    await inTx(async (tx) => {
      await reopenBatchCosts(tx, CH011, "Thử cân nặng riêng");
      await tx`UPDATE items SET weight_kg = 0.6 WHERE variant_id = ${VARIANT_IPAD}`;
      await tx`UPDATE items SET weight_kg = 0.9 WHERE id = ${IPHONE_ITEM}`;
      const r = await catalog.updateVariant(tx, VARIANT_IPHONE, variantInput({ sku: "IPPM-256-SLV", storage: "256GB", color: "Silver", defaultWeightKg: "2" }));
      expect(r).toBeNull(); // không còn máy nào dùng cân nặng mặc định của cấu hình này
    });
  });

  it("nơi mua, đơn vị vận chuyển, tài khoản: thêm · sửa · trùng · đang dùng thì không xoá", async () => {
    await inTx(async (tx) => {
      const s = await catalog.saveSupplier(tx, null, { name: "Costco", kind: "RETAILER", usState: "WA", returnDays: 90, note: null });
      await catalog.saveSupplier(tx, s, { name: "Costco Wholesale", kind: "RETAILER", usState: "WA", returnDays: 90, note: "thẻ thành viên" });
      await expect(
        catalog.saveSupplier(tx, null, { name: "Apple Store", kind: "RETAILER", usState: null, returnDays: null, note: null }),
      ).rejects.toMatchObject({
        code: "DUPLICATE",
      });
      await expect(catalog.deleteSupplier(tx, "30000000-0000-0000-0000-000000000001")).rejects.toMatchObject({ code: "IN_USE" });
      await catalog.deleteSupplier(tx, s);
      expect((await catalog.listSuppliers(tx)).map((x) => [x.name, x.orderCount])).toEqual([["Apple Store", 1]]);

      const c = await catalog.saveCarrier(tx, null, {
        name: "UPS",
        legTypes: ["US_DOMESTIC", "OTHER"],
        trackingUrlTemplate: "https://www.ups.com/track?tracknum={tracking}",
        defaultLeadDays: 3,
        contact: null,
        note: null,
      });
      expect((await catalog.listCarriers(tx)).find((x) => x.id === c)).toMatchObject({ legTypes: ["US_DOMESTIC", "OTHER"], shipmentCount: 0 });
      await catalog.saveCarrier(tx, c, {
        name: "UPS",
        legTypes: ["US_DOMESTIC"],
        trackingUrlTemplate: null,
        defaultLeadDays: null,
        contact: "1-800",
        note: null,
      });
      expect((await catalog.listCarriers(tx)).find((x) => x.id === c)).toMatchObject({ legTypes: ["US_DOMESTIC"], contact: "1-800" });
      await expect(catalog.deleteCarrier(tx, "40000000-0000-0000-0000-000000000002")).rejects.toMatchObject({
        code: "IN_USE",
        message: expect.stringContaining("1 kiện"),
      });
      await catalog.deleteCarrier(tx, c);

      const a = await catalog.saveAccount(tx, null, { name: "Ví MoMo", currency: "VND", kind: "EWALLET", openingBalance: "250000.00", isActive: true });
      expect((await catalog.listAccounts(tx)).find((x) => x.id === a)).toMatchObject({ openingBalance: "250000.00", usageCount: 0 });
      // tài khoản đã có giao dịch: không đổi tiền tệ, không xoá
      const bank = "50000000-0000-0000-0000-000000000002";
      await expect(
        catalog.saveAccount(tx, bank, { name: "Ngân hàng chính", currency: "USD", kind: "BANK", openingBalance: "0", isActive: true }),
      ).rejects.toMatchObject({
        code: "IN_USE",
        field: "currency",
      });
      await expect(catalog.deleteAccount(tx, bank)).rejects.toMatchObject({ code: "IN_USE" });
      await catalog.deleteAccount(tx, a);
      await expect(catalog.deleteAccount(tx, a)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
