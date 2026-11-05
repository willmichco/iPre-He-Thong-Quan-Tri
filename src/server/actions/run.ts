import "server-only";
import { refresh } from "next/cache";
import type { z } from "zod";
import type { FormState } from "@/app/(app)/_components/form-state";
import { validate } from "@/domain/catalog";
import { CostingError } from "@/domain/costing";
import { requireOwner } from "@/server/auth/session";
import { CatalogError } from "@/server/catalog/service";
import { CostingServiceError } from "@/server/costing/service";
import { getSql } from "@/server/db/client";
import { PurchasingError } from "@/server/purchasing/service";
import { ShippingError } from "@/server/shipping/service";
import { CostError } from "@/server/costs/service";
import { SaleError } from "@/server/sales/service";
import { LedgerError } from "@/server/ledger/service";
import { AttachmentError } from "@/server/attachments/service";

export type Db = NonNullable<ReturnType<typeof getSql>>;

/** Lỗi kiểm tra form (theo từng ô). */
export class FormError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super("form");
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = validate(schema, data);
  if (!r.ok) throw new FormError(r.errors);
  return r.data;
}

/** Lỗi nghiệp vụ → thông điệp tiếng Việt cho người dùng; lỗi lạ → ghi log, trả câu chung. */
export function describeError(e: unknown, scope: string): { error: string; fieldErrors?: Record<string, string> } {
  if (e instanceof FormError) return { error: `Kiểm tra lại: ${[...new Set(Object.values(e.errors))].join("; ")}`, fieldErrors: e.errors };
  if (
    e instanceof CatalogError ||
    e instanceof PurchasingError ||
    e instanceof ShippingError ||
    e instanceof CostError ||
    e instanceof SaleError ||
    e instanceof LedgerError ||
    e instanceof AttachmentError
  )
    return { error: e.message, fieldErrors: e.field ? { [e.field]: e.message } : undefined };
  if (e instanceof CostingServiceError || e instanceof CostingError) return { error: e.message };
  console.error(`[${scope}]`, e);
  return { error: "Lỗi hệ thống — chưa lưu được. Thử lại hoặc xem nhật ký máy chủ." };
}

/** Khung chung cho Server Action của form: kiểm tra phiên → có CSDL → chạy → làm mới trang. */
export async function runFormAction(prev: FormState, scope: string, fn: (db: Db) => Promise<string | void>): Promise<FormState> {
  await requireOwner();
  const db = getSql();
  if (!db) return { ok: false, seq: prev.seq, error: "Chưa kết nối cơ sở dữ liệu (thiếu DATABASE_URL)." };
  try {
    const message = (await fn(db)) ?? "Đã lưu";
    refresh();
    return { ok: true, seq: prev.seq + 1, message };
  } catch (e) {
    return { ok: false, seq: prev.seq, ...describeError(e, scope) };
  }
}

export const formFields = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
export const optionalId = (fd: FormData, key = "id") => String(fd.get(key) ?? "").trim() || null;
