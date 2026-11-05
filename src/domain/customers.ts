/**
 * Khách hàng — hàm thuần. Dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15): chỉ thu thông tin cần cho
 * giao hàng và bảo hành; khi khách yêu cầu xoá → ẩn danh hoá (xoá thông tin định danh, giữ giao dịch phục vụ nghĩa vụ thuế).
 */

/** Chuẩn hoá số điện thoại Việt Nam: bỏ khoảng trắng / dấu, +84 / 84 → 0. Rỗng → null; sai định dạng → undefined. */
export function normalizePhone(raw: string): string | null | undefined {
  const s = raw.replace(/[\s.\-()]/g, "");
  if (!s) return null;
  const local = s.replace(/^\+?84(?=\d{9,10}$)/, "0");
  return /^0\d{9,10}$/.test(local) ? local : undefined;
}

export interface CustomerInput {
  fullName: string;
  phone: string | null;
  zalo: string | null;
  facebook: string | null;
  address: string | null;
  note: string | null;
}

export function checkCustomer(
  f: Partial<Record<keyof CustomerInput, string>>,
): { ok: true; data: CustomerInput } | { ok: false; errors: Record<string, string> } {
  const t = (k: keyof CustomerInput, max: number) => (f[k] ?? "").trim().slice(0, max);
  const errors: Record<string, string> = {};
  const fullName = t("fullName", 120);
  if (fullName.length < 2) errors.fullName = "Nhập tên khách";
  const phone = normalizePhone(f.phone ?? "");
  if (phone === undefined) errors.phone = "Số điện thoại không hợp lệ (vd 0901 234 567)";
  if ((f.note ?? "").length > 1000) errors.note = "Ghi chú tối đa 1000 ký tự";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      fullName,
      phone: phone ?? null,
      zalo: t("zalo", 60) || null,
      facebook: t("facebook", 200) || null,
      address: t("address", 300) || null,
      note: t("note", 1000) || null,
    },
  };
}

/** Tên thay thế sau khi ẩn danh — không chứa thông tin gì của khách. */
export const anonymousName = (id: string) => `Khách đã ẩn danh #${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

/** Còn bảo hành tới ngày nào / đã hết (so với hôm nay). */
export function warrantyState(until: string | null, today: string): "NONE" | "ACTIVE" | "EXPIRED" {
  if (!until) return "NONE";
  return until >= today ? "ACTIVE" : "EXPIRED";
}
