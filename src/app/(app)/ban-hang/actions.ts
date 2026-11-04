"use server";

import { parseVndInput, saleSchema } from "@/domain/sales";
import { describeError, formFields, optionalId, parse, runFormAction, type Db } from "@/server/actions/run";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import * as svc from "@/server/sales/service";
import { refresh } from "next/cache";
import type { FormState } from "../_components/form-state";

const run = (prev: FormState, fn: (db: Db) => Promise<string | void>) => runFormAction(prev, "ban-hang", fn);
const need = (fd: FormData, key = "id") => {
  const v = optionalId(fd, key);
  if (!v) throw new svc.SaleError("NOT_FOUND", "Thiếu mã đối tượng");
  return v;
};
const money = (fd: FormData, key: string) => {
  const raw = String(fd.get(key) ?? "").trim();
  if (!raw) return 0n;
  const v = parseVndInput(raw);
  if (v === null) throw new svc.SaleError("INVALID_INPUT", "Số tiền không hợp lệ (vd 2tr · 500k · 2.000.000)", key);
  return v;
};

/** Máy để bán (dạng gửi được qua mạng: số tiền là chuỗi). */
export type SellableDto = Omit<svc.SellableItem, "costVnd" | "targetPriceVnd"> & { costVnd: string; targetPriceVnd: string | null };

export async function lookupForSaleAction(code: string): Promise<SellableDto | null> {
  await requireOwner();
  const db = getSql();
  if (!db) return null;
  const it = await svc.findItemForSale(db, String(code).slice(0, 40));
  return it ? { ...it, costVnd: it.costVnd.toString(), targetPriceVnd: it.targetPriceVnd?.toString() ?? null } : null;
}

export interface CreateSaleState {
  ok: boolean;
  id?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** Bán nhanh: nhận dữ liệu form (chuỗi) từ màn hình, kiểm tra lại toàn bộ ở máy chủ. */
export async function createSaleAction(payload: unknown): Promise<CreateSaleState> {
  await requireOwner();
  const db = getSql();
  if (!db) return { ok: false, error: "Chưa kết nối cơ sở dữ liệu (thiếu DATABASE_URL)." };
  try {
    const r = await svc.createSale(db, parse(saleSchema, payload));
    refresh();
    return { ok: true, id: r.id };
  } catch (e) {
    return { ok: false, ...describeError(e, "ban-hang") };
  }
}

export async function completeSaleAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.completeSale(db, need(fd), {
      directShip: fd.get("directShip") === "on",
      warrantyMonths: Number(fd.get("warrantyMonths") ?? 6),
      accountId: optionalId(fd, "accountId"),
      paidAmount: money(fd, "paidAmount"),
    });
    return "Đã hoàn tất đơn — máy chuyển Đã bán";
  });
}

export async function addPaymentAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const accountId = optionalId(fd, "accountId");
    if (!accountId) throw new svc.SaleError("INVALID_INPUT", "Chọn tài khoản nhận tiền", "accountId");
    await svc.addPayment(db, need(fd), accountId, money(fd, "amount"));
    return "Đã ghi nhận tiền thu";
  });
}

export async function cancelDepositAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.cancelDeposit(db, need(fd), String(fd.get("reason") ?? ""), money(fd, "refund"), optionalId(fd, "accountId"));
    return "Đã huỷ đơn cọc";
  });
}

export async function returnItemAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const f = formFields(fd);
    await svc.returnItem(db, need(fd, "saleItemId"), f.reason ?? "", money(fd, "refund"), optionalId(fd, "accountId"));
    return "Đã ghi nhận khách trả lại — máy về tồn kho";
  });
}
