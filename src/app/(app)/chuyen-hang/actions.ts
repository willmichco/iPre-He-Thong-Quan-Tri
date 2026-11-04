"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { batchSchema, GRID_FIELDS, purchaseOrderSchema, type GridRow, type RowIssue } from "@/domain/purchasing";
import { describeError, formFields, optionalId, parse, runFormAction, type Db } from "@/server/actions/run";
import { requireOwner } from "@/server/auth/session";
import { finalizeBatchCosts, reopenBatchCosts } from "@/server/costing/service";
import { getSql } from "@/server/db/client";
import * as svc from "@/server/purchasing/service";
import type { FormState } from "../_components/form-state";

const run = (prev: FormState, fn: (db: Db) => Promise<string | void>) => runFormAction(prev, "chuyen-hang", fn);
const need = (fd: FormData, key: string) => {
  const v = optionalId(fd, key);
  if (!v) throw new svc.PurchasingError("NOT_FOUND", "Thiếu mã đối tượng");
  return v;
};

// ---- Chuyến ---------------------------------------------------------------------------------------------

export async function createBatchAction(prev: FormState, fd: FormData) {
  let id: string | null = null;
  const state = await run(prev, async (db) => {
    const b = await svc.createBatch(db, parse(batchSchema, formFields(fd)));
    id = b.id;
    return `Đã tạo chuyến ${b.code}`;
  });
  if (state.ok && id) redirect(`/chuyen-hang/${id}`);
  return state;
}

export async function updateBatchAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.updateBatch(db, need(fd, "id"), parse(batchSchema, formFields(fd)));
    return "Đã lưu thông tin chuyến";
  });
}

export async function deleteBatchAction(prev: FormState, fd: FormData) {
  const state = await run(prev, async (db) => {
    await svc.deleteBatch(db, need(fd, "id"));
    return "Đã xoá chuyến";
  });
  if (state.ok) redirect("/chuyen-hang");
  return state;
}

export async function finalizeBatchAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = await finalizeBatchCosts(db, need(fd, "id"));
    return `Đã chốt chi phí chuyến ${r.code} — lãi chuyển từ "Tạm tính" sang "Chốt"`;
  });
}

export async function reopenBatchAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const reason = String(fd.get("reason") ?? "");
    const r = await reopenBatchCosts(db, need(fd, "id"), reason).catch((e) => {
      if (e?.code === "REASON_REQUIRED") throw new svc.PurchasingError("INVALID_ROWS", e.message, "reason");
      throw e;
    });
    return `Đã mở lại chuyến ${r.code}`;
  });
}

// ---- Đơn mua --------------------------------------------------------------------------------------------

export async function savePurchaseOrderAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const id = optionalId(fd);
    const { recalc } = await svc.savePurchaseOrder(db, need(fd, "batchId"), id, parse(purchaseOrderSchema, formFields(fd)));
    const warn = recalc.warnings.length ? ` · ⚠ ${recalc.warnings.map((w) => w.message.replace(/^Đơn mua [0-9a-f-]+: /, "")).join("; ")}` : "";
    return (id ? "Đã lưu đơn mua" : "Đã thêm đơn mua — nhập máy ở lưới bên dưới") + warn;
  });
}

export async function deletePurchaseOrderAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.deletePurchaseOrder(db, need(fd, "id"));
    return "Đã xoá đơn mua";
  });
}

// ---- Lưới máy -------------------------------------------------------------------------------------------

export interface SaveGridResult {
  ok: boolean;
  message?: string;
  error?: string;
  rowIssues?: RowIssue[];
}

/** Lưu cả lưới máy của một đơn mua (gọi từ ItemGrid). */
export async function saveItemsAction(purchaseOrderId: string, rawRows: unknown): Promise<SaveGridResult> {
  await requireOwner();
  const db = getSql();
  if (!db) return { ok: false, error: "Chưa kết nối cơ sở dữ liệu (thiếu DATABASE_URL)." };
  // dữ liệu từ trình duyệt: chỉ nhận đúng các ô chuỗi đã biết
  if (!Array.isArray(rawRows) || rawRows.length > 500) return { ok: false, error: "Dữ liệu lưới không hợp lệ (tối đa 500 dòng)" };
  const rows: GridRow[] = rawRows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const row = Object.fromEntries(GRID_FIELDS.map((f) => [f, typeof o[f] === "string" ? (o[f] as string).slice(0, 200) : ""])) as unknown as GridRow;
    if (typeof o.id === "string" && o.id) row.id = o.id;
    return row;
  });
  try {
    const r = await svc.saveItems(db, String(purchaseOrderId), rows);
    refresh();
    const parts = [r.inserted && `thêm ${r.inserted}`, r.updated && `sửa ${r.updated}`, r.deleted && `xoá ${r.deleted}`].filter(Boolean);
    const changed = r.recalc.batches.filter((b) => b.afterVnd !== b.beforeVnd);
    return {
      ok: true,
      message:
        (parts.length ? `Đã lưu: ${parts.join(", ")} máy` : "Không có thay đổi") +
        (changed.length ? ` · giá vốn tính lại cho ${changed.map((b) => b.code).join(", ")}` : ""),
      rowIssues: r.warnings,
    };
  } catch (e) {
    if (e instanceof svc.PurchasingError && e.rowIssues.length) return { ok: false, error: e.message, rowIssues: e.rowIssues };
    return { ok: false, ...describeError(e, "chuyen-hang") };
  }
}
