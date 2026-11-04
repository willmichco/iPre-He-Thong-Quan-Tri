/**
 * Dịch vụ danh mục: mẫu máy, cấu hình (kèm mã Part No./UPC/EAN), nơi mua, đơn vị vận chuyển, tài khoản tiền.
 * Mọi thao tác ghi đều ghi nhật ký kiểm toán (audit_logs) trong cùng transaction.
 *
 * Đổi cân nặng mặc định của cấu hình → tính lại giá vốn của các chuyến có máy dùng cân nặng mặc định đó
 * (chi phí chia theo cân nặng thay đổi). Chuyến đã chốt mà giá vốn bị đổi → lỗi BATCH_FINALIZED, không lưu.
 *
 * Không import "server-only" để kiểm thử tích hợp & script dùng được; chỉ nhận kết nối CSDL qua tham số.
 */
import type { Sql, TransactionSql } from "postgres";
import {
  checkVariantCode,
  suggestSku,
  variantLabel,
  type AccountInput,
  type CarrierInput,
  type CodeType,
  type ModelInput,
  type SupplierInput,
  type VariantCodeInput,
  type VariantInput,
} from "@/domain/catalog";
import { recalculateBatches, type RecalcResult } from "@/server/costing/service";

type Db = Sql | TransactionSql;

export type CatalogErrorCode = "NOT_FOUND" | "DUPLICATE" | "IN_USE" | "INVALID_CODE";

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    /** ô của form gây lỗi (để giao diện tô đúng chỗ) */
    readonly field?: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/** Lỗi trùng khoá duy nhất của PostgreSQL → lỗi tiếng Việt. */
async function guard<T>(fn: () => Promise<T>, duplicate: { message: string; field?: string }): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new CatalogError("DUPLICATE", duplicate.message, duplicate.field);
    throw e;
  }
}

async function audit(tx: TransactionSql, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, id: string, before: unknown, after: unknown) {
  await tx`
    INSERT INTO audit_logs (action, entity_type, entity_id, before, after)
    VALUES (${action}, ${entityType}, ${id}, ${before === null ? null : tx.json(before as never)}, ${after === null ? null : tx.json(after as never)})`;
}

// ---- Đọc ------------------------------------------------------------------------------------------------

export interface VariantCodeRow {
  codeType: CodeType;
  code: string;
  region: string | null;
}
export interface VariantRow {
  id: string;
  modelId: string;
  sku: string;
  storage: string | null;
  color: string | null;
  chip: string | null;
  memory: string | null;
  connectivity: string | null;
  defaultWeightKg: string | null;
  isActive: boolean;
  label: string;
  itemCount: number;
  codes: VariantCodeRow[];
}
export interface ModelRow {
  id: string;
  category: string;
  name: string;
  releaseYear: number | null;
  variants: VariantRow[];
}

export async function listModels(db: Db): Promise<ModelRow[]> {
  const models = await db<{ id: string; category: string; name: string; release_year: number | null }[]>`
    SELECT id::text, category::text, name, release_year FROM product_models ORDER BY category, name`;
  const variants = await db<
    {
      id: string;
      model_id: string;
      sku: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      weight: string | null;
      is_active: boolean;
      item_count: number;
    }[]
  >`
    SELECT v.id::text, v.model_id::text, v.sku, v.storage, v.color, v.chip, v.memory, v.connectivity,
           v.default_weight_kg::text AS weight, v.is_active,
           (SELECT COUNT(*)::int FROM items i WHERE i.variant_id = v.id AND i.deleted_at IS NULL) AS item_count
      FROM product_variants v ORDER BY v.is_active DESC, v.sku`;
  const codes = await db<{ variant_id: string; code_type: CodeType; code: string; region: string | null }[]>`
    SELECT variant_id::text, code_type, code, region FROM variant_codes ORDER BY code_type, code`;
  return models.map((m) => ({
    id: m.id,
    category: m.category,
    name: m.name,
    releaseYear: m.release_year,
    variants: variants
      .filter((v) => v.model_id === m.id)
      .map((v) => ({
        id: v.id,
        modelId: v.model_id,
        sku: v.sku,
        storage: v.storage,
        color: v.color,
        chip: v.chip,
        memory: v.memory,
        connectivity: v.connectivity,
        defaultWeightKg: v.weight,
        isActive: v.is_active,
        label: variantLabel(m.name, v),
        itemCount: v.item_count,
        codes: codes.filter((c) => c.variant_id === v.id).map((c) => ({ codeType: c.code_type, code: c.code, region: c.region })),
      })),
  }));
}

export interface CodeLookup {
  code: string;
  codeType: CodeType;
  region: string | null;
  variantId: string;
  sku: string;
  label: string;
  defaultWeightKg: string | null;
  isActive: boolean;
}

/** Tra mã trên hộp (Part No./UPC/EAN) → cấu hình máy. Mã không có trong danh mục thì không có trong kết quả. */
export async function lookupCodes(db: Db, raw: readonly string[]): Promise<CodeLookup[]> {
  const codes = [...new Set(raw.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return [];
  const rows = await db<
    {
      code: string;
      code_type: CodeType;
      region: string | null;
      variant_id: string;
      sku: string;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      weight: string | null;
      is_active: boolean;
    }[]
  >`
    SELECT c.code, c.code_type, c.region, v.id::text AS variant_id, v.sku, m.name AS model, v.storage, v.color, v.chip,
           v.memory, v.connectivity, v.default_weight_kg::text AS weight, v.is_active
      FROM variant_codes c JOIN product_variants v ON v.id = c.variant_id JOIN product_models m ON m.id = v.model_id
     WHERE c.code = ANY(${codes})`;
  return rows.map((r) => ({
    code: r.code,
    codeType: r.code_type,
    region: r.region,
    variantId: r.variant_id,
    sku: r.sku,
    label: variantLabel(r.model, r),
    defaultWeightKg: r.weight,
    isActive: r.is_active,
  }));
}

// ---- Mẫu máy --------------------------------------------------------------------------------------------

export async function createModel(db: Db, input: ModelInput): Promise<string> {
  return db.begin(async (tx) => {
    const [row] = await guard(
      () => tx<{ id: string }[]>`
        INSERT INTO product_models (category, name, release_year) VALUES (${input.category}, ${input.name}, ${input.releaseYear})
        RETURNING id::text`,
      { message: `Mẫu máy "${input.name}" đã có trong dòng sản phẩm này`, field: "name" },
    );
    await audit(tx, "CREATE", "product_model", row.id, null, input);
    return row.id;
  });
}

export async function updateModel(db: Db, id: string, input: ModelInput) {
  return db.begin(async (tx) => {
    const [before] = await tx`SELECT category::text, name, release_year FROM product_models WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy mẫu máy");
    await guard(() => tx`UPDATE product_models SET category = ${input.category}, name = ${input.name}, release_year = ${input.releaseYear} WHERE id = ${id}`, {
      message: `Mẫu máy "${input.name}" đã có trong dòng sản phẩm này`,
      field: "name",
    });
    await audit(tx, "UPDATE", "product_model", id, before, input);
  });
}

export async function deleteModel(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [before] = await tx<{ name: string; n: number }[]>`
      SELECT name, (SELECT COUNT(*)::int FROM product_variants WHERE model_id = m.id) AS n FROM product_models m WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy mẫu máy");
    if (before.n) throw new CatalogError("IN_USE", `Mẫu máy "${before.name}" còn ${before.n} cấu hình — xoá các cấu hình trước`);
    await tx`DELETE FROM product_models WHERE id = ${id}`;
    await audit(tx, "DELETE", "product_model", id, before, null);
  });
}

// ---- Cấu hình -------------------------------------------------------------------------------------------

/** Tạo cấu hình; để trống SKU thì tự gợi ý (thêm -2, -3… nếu trùng). */
export async function createVariant(db: Db, input: VariantInput): Promise<{ id: string; sku: string }> {
  return db.begin(async (tx) => {
    const [model] = await tx<{ name: string }[]>`SELECT name FROM product_models WHERE id = ${input.modelId}`;
    if (!model) throw new CatalogError("NOT_FOUND", "Không tìm thấy mẫu máy", "modelId");
    let sku = input.sku;
    if (!sku) {
      const base = suggestSku(model.name, input);
      const taken = new Set((await tx<{ sku: string }[]>`SELECT sku FROM product_variants WHERE sku LIKE ${base + "%"}`).map((r) => r.sku));
      sku = base;
      for (let k = 2; taken.has(sku); k++) sku = `${base}-${k}`;
    }
    const [row] = await guard(
      () => tx<{ id: string }[]>`
        INSERT INTO product_variants (model_id, sku, storage, color, chip, memory, connectivity, default_weight_kg, is_active)
        VALUES (${input.modelId}, ${sku}, ${input.storage}, ${input.color}, ${input.chip}, ${input.memory}, ${input.connectivity},
                ${input.defaultWeightKg}, ${input.isActive})
        RETURNING id::text`,
      { message: `Mã SKU "${sku}" đã được dùng cho cấu hình khác`, field: "sku" },
    );
    await audit(tx, "CREATE", "product_variant", row.id, null, { ...input, sku });
    return { id: row.id, sku };
  });
}

/**
 * Sửa cấu hình. Cân nặng mặc định đổi → tính lại giá vốn các chuyến có máy đang dùng cân nặng mặc định này.
 * Trả kết quả tính lại (null nếu không cần).
 */
export async function updateVariant(db: Db, id: string, input: VariantInput): Promise<RecalcResult | null> {
  return db.begin(async (tx) => {
    const [before] = await tx<{ sku: string; weight: string | null }[]>`
      SELECT sku, default_weight_kg::text AS weight, storage, color, chip, memory, connectivity, is_active, model_id::text
        FROM product_variants WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy cấu hình");
    const sku = input.sku ?? before.sku;
    await guard(
      () => tx`
        UPDATE product_variants SET model_id = ${input.modelId}, sku = ${sku}, storage = ${input.storage}, color = ${input.color},
               chip = ${input.chip}, memory = ${input.memory}, connectivity = ${input.connectivity},
               default_weight_kg = ${input.defaultWeightKg}, is_active = ${input.isActive}
         WHERE id = ${id}`,
      { message: `Mã SKU "${sku}" đã được dùng cho cấu hình khác`, field: "sku" },
    );
    await audit(tx, "UPDATE", "product_variant", id, before, { ...input, sku });
    const weightChanged = (before.weight === null ? null : Number(before.weight)) !== (input.defaultWeightKg === null ? null : Number(input.defaultWeightKg));
    if (!weightChanged) return null;
    const batches = await tx<{ id: string }[]>`
      SELECT DISTINCT batch_id::text AS id FROM items WHERE variant_id = ${id} AND weight_kg IS NULL AND deleted_at IS NULL`;
    return batches.length
      ? recalculateBatches(
          tx,
          batches.map((b) => b.id),
        )
      : null;
  });
}

export async function deleteVariant(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [before] = await tx<{ sku: string; n: number }[]>`
      SELECT sku, (SELECT COUNT(*)::int FROM items WHERE variant_id = v.id) AS n FROM product_variants v WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy cấu hình");
    if (before.n) throw new CatalogError("IN_USE", `Cấu hình ${before.sku} đã dùng cho ${before.n} máy — không xoá được; bỏ chọn "Đang dùng" để ẩn khỏi gợi ý`);
    const codes = await tx`DELETE FROM variant_codes WHERE variant_id = ${id} RETURNING code_type, code`;
    await tx`DELETE FROM product_variants WHERE id = ${id}`;
    await audit(tx, "DELETE", "product_variant", id, { ...before, codes }, null);
  });
}

// ---- Mã trên hộp ----------------------------------------------------------------------------------------

/** Gán một mã (Part No./UPC/EAN) cho cấu hình — lần sau quét mã này là tự điền cấu hình. */
export async function addVariantCode(db: Db, input: VariantCodeInput): Promise<VariantCodeRow> {
  const check = checkVariantCode(input.codeType, input.code);
  if (!check.ok) throw new CatalogError("INVALID_CODE", check.error, "code");
  return db.begin(async (tx) => {
    const [variant] = await tx`SELECT 1 FROM product_variants WHERE id = ${input.variantId}`;
    if (!variant) throw new CatalogError("NOT_FOUND", "Không tìm thấy cấu hình", "variantId");
    const [existing] = await lookupCodes(tx, [check.code]);
    if (existing && existing.codeType === input.codeType)
      throw new CatalogError("DUPLICATE", `Mã ${check.code} đã gán cho ${existing.label} (${existing.sku})`, "code");
    await tx`INSERT INTO variant_codes (code_type, code, variant_id, region) VALUES (${input.codeType}, ${check.code}, ${input.variantId}, ${check.region})`;
    await audit(tx, "CREATE", "variant_code", input.variantId, null, { codeType: input.codeType, code: check.code, region: check.region });
    return { codeType: input.codeType, code: check.code, region: check.region };
  });
}

export async function deleteVariantCode(db: Db, codeType: CodeType, code: string) {
  return db.begin(async (tx) => {
    const [row] = await tx<{ variant_id: string }[]>`
      DELETE FROM variant_codes WHERE code_type = ${codeType} AND code = ${code} RETURNING variant_id::text`;
    if (!row) throw new CatalogError("NOT_FOUND", `Không tìm thấy mã ${code}`);
    await audit(tx, "DELETE", "variant_code", row.variant_id, { codeType, code }, null);
  });
}

// ---- Nơi mua --------------------------------------------------------------------------------------------

export interface SupplierRow extends SupplierInput {
  id: string;
  orderCount: number;
}

export async function listSuppliers(db: Db): Promise<SupplierRow[]> {
  const rows = await db<
    { id: string; name: string; kind: SupplierInput["kind"]; us_state: string | null; return_days: number | null; note: string | null; n: number }[]
  >`
    SELECT s.id::text, s.name, s.kind, s.us_state, s.return_days, s.note,
           (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.deleted_at IS NULL) AS n
      FROM suppliers s ORDER BY s.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, usState: r.us_state, returnDays: r.return_days, note: r.note, orderCount: r.n }));
}

export async function saveSupplier(db: Db, id: string | null, input: SupplierInput): Promise<string> {
  return db.begin(async (tx) => {
    const dup = { message: `Nơi mua "${input.name}" đã có`, field: "name" };
    if (!id) {
      const [row] = await guard(
        () => tx<{ id: string }[]>`
          INSERT INTO suppliers (name, kind, us_state, return_days, note)
          VALUES (${input.name}, ${input.kind}, ${input.usState}, ${input.returnDays}, ${input.note}) RETURNING id::text`,
        dup,
      );
      await audit(tx, "CREATE", "supplier", row.id, null, input);
      return row.id;
    }
    const [before] = await tx`SELECT name, kind, us_state, return_days, note FROM suppliers WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy nơi mua");
    await guard(
      () => tx`
        UPDATE suppliers SET name = ${input.name}, kind = ${input.kind}, us_state = ${input.usState}, return_days = ${input.returnDays},
               note = ${input.note} WHERE id = ${id}`,
      dup,
    );
    await audit(tx, "UPDATE", "supplier", id, before, input);
    return id;
  });
}

export async function deleteSupplier(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [before] = await tx<{ name: string; n: number }[]>`
      SELECT name, (SELECT COUNT(*)::int FROM purchase_orders WHERE supplier_id = s.id) AS n FROM suppliers s WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy nơi mua");
    if (before.n) throw new CatalogError("IN_USE", `"${before.name}" đã có ${before.n} đơn mua — không xoá được`);
    await tx`DELETE FROM suppliers WHERE id = ${id}`;
    await audit(tx, "DELETE", "supplier", id, before, null);
  });
}

// ---- Đơn vị vận chuyển ----------------------------------------------------------------------------------

export interface CarrierRow extends CarrierInput {
  id: string;
  shipmentCount: number;
}

export async function listCarriers(db: Db): Promise<CarrierRow[]> {
  const rows = await db<
    {
      id: string;
      name: string;
      leg_types: string;
      tpl: string | null;
      lead: number | null;
      contact: string | null;
      note: string | null;
      n: number;
    }[]
  >`
    SELECT c.id::text, c.name, c.leg_types::text, c.tracking_url_template AS tpl, c.default_lead_days AS lead, c.contact, c.note,
           (SELECT COUNT(*)::int FROM shipments s WHERE s.carrier_id = c.id) AS n
      FROM carriers c ORDER BY c.name`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    // mảng enum đọc dạng văn bản "{US_DOMESTIC,US_TO_VN}"
    legTypes: r.leg_types.replace(/[{}]/g, "").split(",").filter(Boolean) as CarrierInput["legTypes"],
    trackingUrlTemplate: r.tpl,
    defaultLeadDays: r.lead,
    contact: r.contact,
    note: r.note,
    shipmentCount: r.n,
  }));
}

export async function saveCarrier(db: Db, id: string | null, input: CarrierInput): Promise<string> {
  return db.begin(async (tx) => {
    const dup = { message: `Đơn vị vận chuyển "${input.name}" đã có`, field: "name" };
    const legs = `{${input.legTypes.join(",")}}`;
    if (!id) {
      const [row] = await guard(
        () => tx<{ id: string }[]>`
          INSERT INTO carriers (name, leg_types, tracking_url_template, default_lead_days, contact, note)
          VALUES (${input.name}, ${legs}::leg_type[], ${input.trackingUrlTemplate}, ${input.defaultLeadDays}, ${input.contact}, ${input.note})
          RETURNING id::text`,
        dup,
      );
      await audit(tx, "CREATE", "carrier", row.id, null, input);
      return row.id;
    }
    const [before] = await tx`
      SELECT name, leg_types::text, tracking_url_template, default_lead_days, contact, note FROM carriers WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy đơn vị vận chuyển");
    await guard(
      () => tx`
        UPDATE carriers SET name = ${input.name}, leg_types = ${legs}::leg_type[], tracking_url_template = ${input.trackingUrlTemplate},
               default_lead_days = ${input.defaultLeadDays}, contact = ${input.contact}, note = ${input.note}
         WHERE id = ${id}`,
      dup,
    );
    await audit(tx, "UPDATE", "carrier", id, before, input);
    return id;
  });
}

export async function deleteCarrier(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [before] = await tx<{ name: string; n: number }[]>`
      SELECT name, (SELECT COUNT(*)::int FROM shipments WHERE carrier_id = c.id) AS n FROM carriers c WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy đơn vị vận chuyển");
    if (before.n) throw new CatalogError("IN_USE", `"${before.name}" đã chở ${before.n} kiện — không xoá được`);
    await tx`DELETE FROM carriers WHERE id = ${id}`;
    await audit(tx, "DELETE", "carrier", id, before, null);
  });
}

// ---- Tài khoản tiền -------------------------------------------------------------------------------------

export interface AccountRow extends AccountInput {
  id: string;
  usageCount: number;
}

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  const rows = await db<{ id: string; name: string; currency: "VND" | "USD"; kind: AccountInput["kind"]; opening: string; is_active: boolean; n: number }[]>`
    SELECT a.id::text, a.name, a.currency::text AS currency, a.kind, a.opening_balance::text AS opening, a.is_active,
           ((SELECT COUNT(*) FROM cash_transactions t WHERE t.account_id = a.id)
          + (SELECT COUNT(*) FROM purchase_orders po WHERE po.payment_account_id = a.id)
          + (SELECT COUNT(*) FROM costs c WHERE c.account_id = a.id)
          + (SELECT COUNT(*) FROM sale_expenses e WHERE e.account_id = a.id))::int AS n
      FROM accounts a ORDER BY a.is_active DESC, a.name`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency,
    kind: r.kind,
    openingBalance: r.opening,
    isActive: r.is_active,
    usageCount: r.n,
  }));
}

export async function saveAccount(db: Db, id: string | null, input: AccountInput): Promise<string> {
  return db.begin(async (tx) => {
    const dup = { message: `Tài khoản "${input.name}" đã có`, field: "name" };
    if (!id) {
      const [row] = await guard(
        () => tx<{ id: string }[]>`
          INSERT INTO accounts (name, currency, kind, opening_balance, is_active)
          VALUES (${input.name}, ${input.currency}, ${input.kind}, ${input.openingBalance}, ${input.isActive}) RETURNING id::text`,
        dup,
      );
      await audit(tx, "CREATE", "account", row.id, null, input);
      return row.id;
    }
    const [before] = await tx<{ currency: string; n: number }[]>`
      SELECT name, currency::text, kind, opening_balance::text, is_active,
             (SELECT COUNT(*)::int FROM cash_transactions WHERE account_id = a.id) AS n
        FROM accounts a WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new CatalogError("NOT_FOUND", "Không tìm thấy tài khoản");
    if (before.n && before.currency !== input.currency)
      throw new CatalogError("IN_USE", `Tài khoản đã có ${before.n} giao dịch — không đổi được tiền tệ`, "currency");
    await guard(
      () => tx`
        UPDATE accounts SET name = ${input.name}, currency = ${input.currency}, kind = ${input.kind}, opening_balance = ${input.openingBalance},
               is_active = ${input.isActive} WHERE id = ${id}`,
      dup,
    );
    await audit(tx, "UPDATE", "account", id, before, input);
    return id;
  });
}

export async function deleteAccount(db: Db, id: string) {
  return db.begin(async (tx) => {
    const [row] = await tx<{ name: string }[]>`SELECT name FROM accounts WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new CatalogError("NOT_FOUND", "Không tìm thấy tài khoản");
    const [usage] = (await listAccounts(tx)).filter((a) => a.id === id);
    if (usage.usageCount) throw new CatalogError("IN_USE", `"${row.name}" đã dùng ở ${usage.usageCount} giao dịch/chứng từ — bỏ chọn "Đang dùng" để ẩn`);
    await tx`DELETE FROM accounts WHERE id = ${id}`;
    await audit(tx, "DELETE", "account", id, row, null);
  });
}
