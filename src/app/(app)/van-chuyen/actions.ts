"use server";

import { redirect } from "next/navigation";
import { parseScanList, shipmentSchema, vnLocalToIso } from "@/domain/shipping";
import { isTimeZone, zonedLocalToIso } from "@/domain/tracking";
import { formFields, optionalId, parse, runFormAction, type Db } from "@/server/actions/run";
import * as svc from "@/server/shipping/service";
import * as bot from "@/server/tracking/service";
import type { FormState } from "../_components/form-state";

const run = (prev: FormState, fn: (db: Db) => Promise<string | void>) => runFormAction(prev, "van-chuyen", fn);
const need = (fd: FormData, key = "id") => {
  const v = optionalId(fd, key);
  if (!v) throw new svc.ShippingError("NOT_FOUND", "Thiếu mã đối tượng");
  return v;
};
/** Ô ngày giờ + ô múi giờ (`tz`, mặc định giờ VN) → ISO. Mốc ở Mỹ nhập theo giờ địa phương, hệ thống tự đổi. */
const when = (fd: FormData) => {
  const local = String(fd.get("at") ?? "");
  const tz = String(fd.get("tz") ?? "Asia/Ho_Chi_Minh");
  const iso = tz === "Asia/Ho_Chi_Minh" || !isTimeZone(tz) ? vnLocalToIso(local) : zonedLocalToIso(local, tz);
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

/** Nhận kiện theo kết quả quét đối chiếu (trang /van-chuyen/[id]/nhan). Xong → về trang kiện. */
export async function receiveScanAction(prev: FormState, fd: FormData) {
  let id: string | null = null;
  const state = await run(prev, async (db) => {
    id = need(fd);
    const codes = parseScanList(String(fd.get("codes") ?? ""));
    if (codes.length > 1000) throw new svc.ShippingError("INVALID_INPUT", "Tối đa 1000 mã mỗi lần", "codes");
    const r = await svc.receiveByScan(db, id, codes, when(fd), fd.get("acceptShortage") === "on");
    const parts = [`Đã nhận ${r.received} máy`];
    if (r.missing.length) parts.push(`ghi sự cố thiếu ${r.missing.length} máy`);
    for (const x of r.outside) parts.push(`⚠ ${x.code}: ${x.reason}`);
    return parts.join(" · ");
  });
  if (state.ok && id) redirect(`/van-chuyen/${id}?nhan=1`);
  return state;
}

/** Máy thiếu đã về sau → nhận bổ sung. */
export async function receiveLateAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    await svc.receiveLateItem(db, need(fd), need(fd, "itemId"), when(fd));
    return "Đã nhận bổ sung — đóng sự cố cho máy này";
  });
}

// ---- Bot theo dõi vận đơn ------------------------------------------------------------------------------

/** Dán link tra cứu / mã vận đơn → bot nhận hãng, tạo kiện (nếu chưa có) và theo dõi. Một kiện → mở trang kiện. */
export async function trackLinkAction(prev: FormState, fd: FormData) {
  let go: string | null = null;
  const state = await run(prev, async (db) => {
    const r = await bot.trackFromText(db, String(fd.get("link") ?? "").slice(0, 4000));
    if (r.added.length === 1) go = `/van-chuyen/${r.added[0].id}`;
    const made = r.added.filter((a) => a.created).length;
    const parts = [
      made ? `Đã tạo ${made} kiện` : null,
      r.added.length - made ? `${r.added.length - made} vận đơn đã có kiện — bật theo dõi` : null,
      r.run?.unconfigured ? "chưa có khoá API của hãng nên bot chưa kiểm tra được (xem thẻ Bot theo dõi ở Tổng quan)" : null,
    ].filter(Boolean);
    return `${r.added.map((a) => a.number).join(", ")}: ${parts.join(" · ")}`;
  });
  if (state.ok && go) redirect(go);
  return state;
}

export async function runBotAction(prev: FormState) {
  return run(prev, async (db) => {
    const r = await bot.runTrackingBot(db, { trigger: "MANUAL" });
    if (r.skipped) return "Bot đang chạy — đợi vài phút rồi xem lại";
    return `Đã kiểm tra ${r.checked} kiện · ${r.changed} có cập nhật mới${r.failed ? ` · ${r.failed} lỗi` : ""}${r.unconfigured ? ` · ${r.unconfigured} kiện chưa có nguồn dữ liệu` : ""}`;
  });
}

export async function checkOneAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const r = await bot.runTrackingBot(db, { trigger: "MANUAL", shipmentIds: [need(fd)] });
    if (r.unconfigured) return "Chưa có nguồn dữ liệu cho hãng này — xem dòng báo lỗi của bot";
    return r.failed ? "Hãng trả lỗi — xem dòng báo lỗi của bot" : r.changed ? "Có cập nhật mới từ hãng" : "Không có gì mới";
  });
}

export async function toggleTrackAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const on = fd.get("on") === "1";
    await bot.setTrackEnabled(db, need(fd), on);
    return on ? "Đã bật bot theo dõi cho kiện" : "Đã tắt bot theo dõi cho kiện";
  });
}

export async function labelCreatedAction(prev: FormState, fd: FormData) {
  return run(prev, async (db) => {
    const clear = fd.get("do") === "clear";
    await bot.setLabelCreated(db, need(fd), clear ? null : when(fd));
    return clear ? "Đã xoá giờ tạo nhãn" : "Đã lưu giờ người bán tạo nhãn";
  });
}
