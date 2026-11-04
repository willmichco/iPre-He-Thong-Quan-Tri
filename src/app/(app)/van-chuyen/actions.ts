"use server";

import { redirect } from "next/navigation";
import { parseScanList, shipmentSchema, vnLocalToIso } from "@/domain/shipping";
import { formFields, optionalId, parse, runFormAction, type Db } from "@/server/actions/run";
import * as svc from "@/server/shipping/service";
import type { FormState } from "../_components/form-state";

const run = (prev: FormState, fn: (db: Db) => Promise<string | void>) => runFormAction(prev, "van-chuyen", fn);
const need = (fd: FormData, key = "id") => {
  const v = optionalId(fd, key);
  if (!v) throw new svc.ShippingError("NOT_FOUND", "Thiếu mã đối tượng");
  return v;
};
const when = (fd: FormData) => {
  const iso = vnLocalToIso(String(fd.get("at") ?? ""));
  if (!iso) throw new svc.ShippingError("INVALID_INPUT", "Chọn ngày giờ", "at");
  return iso;
};

export async function createShipmentAction(prev: FormState, fd: FormData) {
  let id: string | null = null;
  const state = await run(prev, async (db) => {
    id = await svc.createShipment(db, parse(shipmentSchema, formFields(fd)));
    return "Đã tạo kiện";
  });
  if (state.ok && id) redirect(`/van-chuyen/${id}`);
  return state;
}

export async function updateShipmentAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.updateShipment(db, need(fd), parse(shipmentSchema, formFields(fd)));
    return "Đã lưu thông tin kiện";
  });
}

export async function deleteShipmentAction(prev: FormState, fd: FormData) {
  const state = await run(prev, async (db) => {
    await svc.deleteShipment(db, need(fd));
    return "Đã xoá kiện";
  });
  if (state.ok) redirect("/van-chuyen");
  return state;
}

export async function assignAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const codes = parseScanList(String(fd.get("codes") ?? ""));
    if (!codes.length) throw new svc.ShippingError("INVALID_INPUT", "Quét hoặc dán Serial / IMEI", "codes");
    if (codes.length > 300) throw new svc.ShippingError("INVALID_INPUT", "Tối đa 300 mã mỗi lần", "codes");
    const r = await svc.assignItems(db, need(fd), codes);
    const parts = [r.added.length ? `Đã thêm ${r.added.length} máy vào kiện` : "Chưa thêm máy nào"];
    for (const x of r.rejected) parts.push(`⚠ ${x.code}: ${x.reason}`);
    return parts.join(" · ");
  });
}

export async function removeItemAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.removeItem(db, need(fd), need(fd, "itemId"));
    return "Đã bỏ máy khỏi kiện";
  });
}

export async function shipAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = await svc.markShipped(db, need(fd), when(fd));
    return `Đã gửi đi — ghi mốc cho ${r.itemCount} máy${r.eta ? ` · dự kiến nhận ${r.eta.split("-").reverse().join("/")}` : ""}`;
  });
}

export async function arriveAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = await svc.markArrived(db, need(fd), when(fd));
    return `Đã nhận — ghi mốc cho ${r.itemCount} máy`;
  });
}

export async function holdAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const hold = fd.get("hold") === "1";
    await svc.setHold(db, need(fd), hold, String(fd.get("note") ?? "").trim() || undefined);
    return hold ? "Đã đánh dấu giữ hải quan" : "Đã bỏ giữ hải quan";
  });
}
