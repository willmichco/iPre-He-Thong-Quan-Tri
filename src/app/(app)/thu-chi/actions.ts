"use server";

import { redirect } from "next/navigation";
import { checkManualEntry, checkTransfer, parseBalance, parseRate, type Currency } from "@/domain/ledger";
import { FormError, formFields, optionalId, runFormAction, type Db } from "@/server/actions/run";
import * as svc from "@/server/ledger/service";
import type { FormState } from "../_components/form-state";

const run = (prev: FormState, fn: (db: Db) => Promise<string | void>) => runFormAction(prev, "thu-chi", fn);
const need = (fd: FormData, key = "id") => {
  const v = optionalId(fd, key);
  if (!v) throw new svc.LedgerError("NOT_FOUND", "Thiếu mã đối tượng");
  return v;
};
const date = (fd: FormData, key: string) => {
  const v = String(fd.get(key) ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new FormError({ [key]: "Chọn ngày" });
  return v;
};

export async function saveEntryAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = checkManualEntry(formFields(fd));
    if (!r.ok) throw new FormError(r.errors);
    const id = optionalId(fd);
    await svc.saveManualEntry(db, id, r.data);
    return id ? "Đã lưu bút toán" : "Đã ghi vào sổ quỹ";
  });
}

export async function deleteEntryAction(prev: FormState, fd: FormData) {
  const r = await run(prev, async (db) => {
    await svc.deleteEntry(db, need(fd));
    return "Đã xoá bút toán";
  });
  // xoá từ trang chi tiết → về sổ quỹ (trang chi tiết không còn)
  if (r.ok && fd.get("back") === "1") redirect("/thu-chi");
  return r;
}

export async function transferAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = checkTransfer(formFields(fd));
    if (!r.ok) throw new FormError(r.errors);
    await svc.createTransfer(db, r.data);
    return "Đã ghi chuyển tiền (2 bút toán)";
  });
}

export async function reconcileAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const accountId = need(fd, "accountId");
    const currency = String(fd.get("currency") ?? "VND") as Currency;
    const statement = parseBalance(String(fd.get("statement") ?? ""), currency);
    if (statement === null) throw new FormError({ statement: "Nhập số dư trên sao kê (vd 12.500.000)" });
    const rawRate = String(fd.get("fxRate") ?? "").trim();
    const fxRate = rawRate ? parseRate(rawRate) : null;
    if (rawRate && !fxRate) throw new FormError({ fxRate: "Tỷ giá không hợp lệ" });
    const r = await svc.reconcile(db, {
      accountId,
      asOf: date(fd, "asOf"),
      statementCents: statement,
      adjust: fd.get("adjust") === "on",
      fxRate,
      note: String(fd.get("note") ?? "").trim() || null,
    });
    if (r.diffCents === 0n) return "Khớp số dư ✓";
    return r.adjusted ? "Đã ghi đối soát và bút toán điều chỉnh cho khớp" : "Đã ghi đối soát — còn chênh lệch, xem bảng bên dưới";
  });
}

export async function markPaidAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const kind = String(fd.get("kind") ?? "");
    if (kind !== "PURCHASE_ORDER" && kind !== "COST" && kind !== "SALE_EXPENSE") throw new svc.LedgerError("INVALID_INPUT", "Loại công nợ không hợp lệ");
    const accountId = optionalId(fd, "accountId");
    if (!accountId) throw new FormError({ accountId: "Chọn tài khoản trả" });
    await svc.markPaid(db, { kind, id: need(fd), accountId, paidAt: date(fd, "paidAt") });
    return "Đã ghi trả — bút toán vào sổ quỹ";
  });
}

export async function saveCategoryAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const direction = fd.get("direction") === "IN" ? "IN" : "OUT";
    const code = optionalId(fd, "code");
    await svc.saveCategory(db, code, { name: String(fd.get("name") ?? ""), direction, isOperating: fd.get("isOperating") === "on" });
    return code ? "Đã lưu danh mục" : "Đã thêm danh mục";
  });
}

export async function deleteCategoryAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.deleteCategory(db, need(fd, "code"));
    return "Đã xoá danh mục";
  });
}
