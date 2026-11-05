"use server";

import { redirect } from "next/navigation";
import { checkCustomer } from "@/domain/customers";
import { FormError, formFields, optionalId, runFormAction } from "@/server/actions/run";
import { anonymizeCustomer, CustomerError, saveCustomer } from "@/server/customers/service";
import type { FormState } from "../../_components/form-state";

export async function saveCustomerAction(prev: FormState, fd: FormData) {
  let createdId: string | null = null;
  const r = await runFormAction(prev, "khach-hang", async (db) => {
    const c = checkCustomer(formFields(fd));
    if (!c.ok) throw new FormError(c.errors);
    const id = optionalId(fd);
    const saved = await saveCustomer(db, id, c.data);
    if (!id) createdId = saved;
    return id ? "Đã lưu thông tin khách" : "Đã thêm khách";
  });
  if (r.ok && createdId) redirect(`/ban-hang/khach-hang/${createdId}`);
  return r;
}

export async function anonymizeCustomerAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "khach-hang", async (db) => {
    const id = optionalId(fd);
    if (!id) throw new CustomerError("NOT_FOUND", "Thiếu mã khách");
    await anonymizeCustomer(db, id, String(fd.get("reason") ?? ""));
    return "Đã ẩn danh hoá — thông tin cá nhân đã xoá, giao dịch được giữ lại";
  });
}
