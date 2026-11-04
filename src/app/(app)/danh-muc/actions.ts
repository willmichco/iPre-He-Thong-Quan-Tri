"use server";

import { refresh } from "next/cache";
import {
  accountSchema,
  carrierSchema,
  CODE_TYPES,
  modelSchema,
  supplierSchema,
  validate,
  variantCodeSchema,
  variantSchema,
  type CodeType,
} from "@/domain/catalog";
import { CostingError } from "@/domain/costing";
import { requireOwner } from "@/server/auth/session";
import * as catalog from "@/server/catalog/service";
import { CostingServiceError } from "@/server/costing/service";
import { getSql } from "@/server/db/client";
import type { FormState } from "./state";

type Db = NonNullable<ReturnType<typeof getSql>>;

/** Khung chung: kiểm tra phiên → có CSDL → chạy → làm mới trang; lỗi nghiệp vụ trả về tiếng Việt. */
async function run(prev: FormState, fn: (db: Db) => Promise<string | void>): Promise<FormState> {
  await requireOwner();
  const db = getSql();
  if (!db) return { ok: false, seq: prev.seq, error: "Chưa kết nối cơ sở dữ liệu (thiếu DATABASE_URL)." };
  try {
    const message = (await fn(db)) ?? "Đã lưu";
    refresh();
    return { ok: true, seq: prev.seq + 1, message };
  } catch (e) {
    if (e instanceof FormError) return { ok: false, seq: prev.seq, error: "Kiểm tra lại các ô được đánh dấu", fieldErrors: e.errors };
    if (e instanceof catalog.CatalogError) return { ok: false, seq: prev.seq, error: e.message, fieldErrors: e.field ? { [e.field]: e.message } : undefined };
    if (e instanceof CostingServiceError || e instanceof CostingError) return { ok: false, seq: prev.seq, error: e.message };
    console.error("[danh-muc]", e);
    return { ok: false, seq: prev.seq, error: "Lỗi hệ thống — chưa lưu được. Thử lại hoặc xem nhật ký máy chủ." };
  }
}

class FormError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super("form");
  }
}

function parse<S extends Parameters<typeof validate>[0]>(schema: S, data: unknown) {
  const r = validate(schema, data);
  if (!r.ok) throw new FormError(r.errors);
  return r.data as import("zod").output<S>;
}

const fields = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
const idOf = (fd: FormData) => {
  const id = String(fd.get("id") ?? "").trim();
  return id || null;
};
const requireId = (fd: FormData) => {
  const id = idOf(fd);
  if (!id) throw new catalog.CatalogError("NOT_FOUND", "Thiếu mã đối tượng");
  return id;
};

// ---- Mẫu máy & cấu hình ---------------------------------------------------------------------------------

export async function saveModelAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(modelSchema, fields(fd));
    const id = idOf(fd);
    if (id) await catalog.updateModel(db, id, input);
    else await catalog.createModel(db, input);
    return id ? `Đã sửa mẫu máy ${input.name}` : `Đã thêm mẫu máy ${input.name}`;
  });
}

export async function deleteModelAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await catalog.deleteModel(db, requireId(fd));
    return "Đã xoá mẫu máy";
  });
}

export async function saveVariantAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(variantSchema, { isActive: "", ...fields(fd) });
    const id = idOf(fd);
    if (!id) {
      const { sku } = await catalog.createVariant(db, input);
      return `Đã thêm cấu hình ${sku}`;
    }
    const recalc = await catalog.updateVariant(db, id, input);
    if (!recalc) return "Đã lưu cấu hình";
    const changed = recalc.batches.filter((b) => b.inserted + b.updated + b.deleted > 0);
    return changed.length
      ? `Đã lưu cấu hình — giá vốn tính lại cho chuyến ${changed.map((b) => b.code).join(", ")}`
      : "Đã lưu cấu hình (giá vốn các chuyến không đổi)";
  });
}

export async function deleteVariantAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await catalog.deleteVariant(db, requireId(fd));
    return "Đã xoá cấu hình";
  });
}

export async function addCodeAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(variantCodeSchema, fields(fd));
    const row = await catalog.addVariantCode(db, input);
    return `Đã gán mã ${row.code}${row.region ? ` (thị trường ${row.region})` : ""}`;
  });
}

export async function deleteCodeAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const type = String(fd.get("codeType")) as CodeType;
    if (!CODE_TYPES.includes(type)) throw new catalog.CatalogError("NOT_FOUND", "Loại mã không hợp lệ");
    await catalog.deleteVariantCode(db, type, String(fd.get("code") ?? ""));
    return "Đã bỏ mã";
  });
}

// ---- Nơi mua · vận chuyển · tài khoản -------------------------------------------------------------------

export async function saveSupplierAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(supplierSchema, fields(fd));
    const id = idOf(fd);
    await catalog.saveSupplier(db, id, input);
    return id ? `Đã sửa ${input.name}` : `Đã thêm nơi mua ${input.name}`;
  });
}

export async function deleteSupplierAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await catalog.deleteSupplier(db, requireId(fd));
    return "Đã xoá nơi mua";
  });
}

export async function saveCarrierAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(carrierSchema, { ...fields(fd), legTypes: fd.getAll("legTypes").map(String) });
    const id = idOf(fd);
    await catalog.saveCarrier(db, id, input);
    return id ? `Đã sửa ${input.name}` : `Đã thêm đơn vị vận chuyển ${input.name}`;
  });
}

export async function deleteCarrierAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await catalog.deleteCarrier(db, requireId(fd));
    return "Đã xoá đơn vị vận chuyển";
  });
}

export async function saveAccountAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const input = parse(accountSchema, { isActive: "", ...fields(fd) });
    const id = idOf(fd);
    await catalog.saveAccount(db, id, input);
    return id ? `Đã sửa ${input.name}` : `Đã thêm tài khoản ${input.name}`;
  });
}

export async function deleteAccountAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await catalog.deleteAccount(db, requireId(fd));
    return "Đã xoá tài khoản";
  });
}

// ---- Tra mã cho bộ quét ---------------------------------------------------------------------------------

/** Bộ quét gọi để hiện cấu hình của Part No./UPC vừa đọc được. */
export async function lookupCodesAction(codes: string[]): Promise<catalog.CodeLookup[]> {
  await requireOwner();
  const db = getSql();
  if (!db || !Array.isArray(codes)) return [];
  return catalog.lookupCodes(db, codes.slice(0, 50).map(String));
}
