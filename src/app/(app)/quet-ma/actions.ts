"use server";

import { sanitizeRecords } from "@/domain/scan-inbox";
import { describeError, optionalId, runFormAction } from "@/server/actions/run";
import { requireOwner } from "@/server/auth/session";
import { getSql } from "@/server/db/client";
import { PurchasingError } from "@/server/purchasing/service";
import { confirmIntoPurchaseOrder, confirmIntoShipment, discardCaptures, ScanInboxError, submitCaptures, updateCapture } from "@/server/scans/service";
import { refresh } from "next/cache";
import type { FormState } from "../_components/form-state";

/** Điện thoại gửi phiên quét vào hộp chờ duyệt (gọi trực tiếp từ bộ quét). */
export async function submitScansAction(records: unknown): Promise<{ ok: boolean; message: string }> {
  await requireOwner();
  const db = getSql();
  if (!db) return { ok: false, message: "Chưa kết nối cơ sở dữ liệu" };
  try {
    const r = await submitCaptures(db, sanitizeRecords(records));
    refresh();
    return { ok: true, message: `Đã gửi ${r.added} máy vào hộp chờ duyệt${r.skipped ? ` (bỏ qua ${r.skipped} máy đã gửi trước đó)` : ""}` };
  } catch (e) {
    // lỗi cấu trúc dữ liệu gửi lên (sanitizeRecords) đã là câu tiếng Việt dễ hiểu
    const plain = e instanceof Error && /^(Dữ liệu|Tối đa)/.test(e.message);
    return { ok: false, message: plain ? (e as Error).message : describeError(e, "hop-cho").error };
  }
}

const ids = (fd: FormData) =>
  fd
    .getAll("ids")
    .map(String)
    .filter((x) => /^[0-9a-f-]{36}$/i.test(x));

export async function inboxAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "hop-cho", async (db) => {
    const action = String(fd.get("do") ?? "");
    const selected = ids(fd);
    if (action === "bo") {
      const n = await discardCaptures(db, selected);
      return `Đã bỏ ${n} dòng`;
    }
    if (action === "don-mua") {
      const purchaseOrderId = optionalId(fd, "purchaseOrderId");
      if (!purchaseOrderId) throw new ScanInboxError("INVALID_INPUT", "Chọn đơn mua", "purchaseOrderId");
      try {
        const r = await confirmIntoPurchaseOrder(db, selected, {
          purchaseOrderId,
          unitPrice: String(fd.get("unitPrice") ?? ""),
          variantId: optionalId(fd, "variantId"),
        });
        return `Đã tạo ${r.created} máy trong đơn mua — giá vốn đã tính lại`;
      } catch (e) {
        // lỗi lưới nhập máy (trùng Serial, IMEI sai…) → gom thành một câu dễ hiểu
        if (e instanceof PurchasingError && e.rowIssues?.length) throw new ScanInboxError("INVALID_INPUT", e.rowIssues.map((i) => i.message).join("; "));
        throw e;
      }
    }
    if (action === "kien") {
      const shipmentId = optionalId(fd, "shipmentId");
      if (!shipmentId) throw new ScanInboxError("INVALID_INPUT", "Chọn kiện", "shipmentId");
      const r = await confirmIntoShipment(db, selected, shipmentId);
      const why = r.rejected.length
        ? ` · giữ lại ${r.kept}: ${r.rejected.map((x) => `${x.code} — ${x.reason}`).join("; ")}`
        : r.kept
          ? ` · giữ lại ${r.kept} dòng chưa khớp máy nào`
          : "";
      return `Đã nhận ${r.confirmed} máy vào kiện${why}`;
    }
    throw new ScanInboxError("INVALID_INPUT", "Chọn thao tác");
  });
}

export async function updateCaptureAction(prev: FormState, fd: FormData) {
  return runFormAction(prev, "hop-cho", async (db) => {
    const id = optionalId(fd);
    if (!id) throw new ScanInboxError("NOT_FOUND", "Thiếu mã dòng");
    await updateCapture(db, id, {
      serial: String(fd.get("serial") ?? ""),
      imei1: String(fd.get("imei1") ?? ""),
      imei2: String(fd.get("imei2") ?? ""),
      partNumber: String(fd.get("partNumber") ?? ""),
    });
    return "Đã sửa";
  });
}
