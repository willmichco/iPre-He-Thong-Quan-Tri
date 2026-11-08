/**
 * Nhật ký kiểm toán — phần thuần: nhãn, đường dẫn tới đối tượng, so sánh trước / sau để hiển thị.
 * Dữ liệu ghi ở bảng audit_logs (chỉ thêm, không sửa / xoá) từ mọi thao tác ghi của hệ thống.
 */

export const ACTION_LABEL: Record<string, string> = {
  CREATE: "Tạo",
  UPDATE: "Sửa",
  DELETE: "Xoá",
  RESTORE: "Khôi phục",
  FINALIZE: "Chốt",
  REOPEN: "Mở lại",
  LOGIN: "Đăng nhập",
};

export const ENTITY_LABEL: Record<string, string> = {
  batch: "Chuyến hàng",
  purchase_order: "Đơn mua",
  item: "Máy",
  shipment: "Kiện",
  cost: "Chi phí",
  sale: "Đơn bán",
  customer: "Khách hàng",
  cash_transaction: "Bút toán thu chi",
  transfer: "Chuyển tiền",
  reconciliation: "Đối soát",
  cash_category: "Danh mục thu chi",
  account: "Tài khoản",
  supplier: "Nơi mua",
  carrier: "Đơn vị vận chuyển",
  product_model: "Mẫu máy",
  product_variant: "Cấu hình",
  variant_code: "Mã Part No. / UPC",
  attachment: "Chứng từ",
  scan_capture: "Hộp chờ duyệt",
  app_setting: "Cài đặt",
  data_export: "Tải dữ liệu",
  assistant_action: "Trợ lý (phiếu xác nhận)",
};

/** Trang xem đối tượng (nếu có trang riêng). */
export function entityHref(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case "batch":
      return `/chuyen-hang/${id}`;
    case "shipment":
      return `/van-chuyen/${id}`;
    case "item":
      return `/kho/${id}`;
    case "sale":
      return `/ban-hang/${id}`;
    case "customer":
      return `/ban-hang/khach-hang/${id}`;
    case "cash_transaction":
      return `/thu-chi/${id}`;
    case "account":
      return `/thu-chi/tai-khoan/${id}`;
    default:
      return null;
  }
}

export interface FieldChange {
  key: string;
  before: string | null;
  after: string | null;
}

const MAX = 160;
/** Giá trị JSON → chuỗi ngắn để hiển thị (null / thiếu → null). */
export function show(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Các trường đổi giữa `before` và `after`. Chỉ có `after` (tạo) / chỉ có `before` (xoá) → liệt kê toàn bộ.
 * Trường giống nhau bị bỏ. Không phải object (hiếm) → một dòng "giá trị".
 */
export function changes(before: unknown, after: unknown): FieldChange[] {
  if (!isObj(before) && !isObj(after)) {
    const b = show(before);
    const a = show(after);
    return b === a ? [] : [{ key: "giá trị", before: b, after: a }];
  }
  const B = isObj(before) ? before : {};
  const A = isObj(after) ? after : {};
  const keys = [...new Set([...Object.keys(B), ...Object.keys(A)])];
  const out: FieldChange[] = [];
  for (const key of keys) {
    const b = show(B[key]);
    const a = show(A[key]);
    if (b === a) continue;
    out.push({ key, before: b, after: a });
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const real = (d: string) => DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export interface AuditFilter {
  entityType: string | null;
  action: string | null;
  /** ngày VN, gồm cả 2 đầu */
  from: string | null;
  to: string | null;
  /** tìm trong mã đối tượng và nội dung trước / sau (Serial, IMEI, mã chuyến…) */
  q: string | null;
  entityId: string | null;
  /** phân trang lùi theo id */
  beforeId: number | null;
}

/** Tham số trang (?loai=&thao-tac=&tu=&den=&q=&id=&truoc=) → bộ lọc hợp lệ; giá trị lạ bị bỏ qua. */
export function parseAuditFilter(sp: Record<string, string | string[] | undefined>): AuditFilter {
  const one = (k: string) => {
    const v = sp[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s : null;
  };
  const type = one("loai");
  const action = one("thao-tac");
  const from = one("tu");
  const to = one("den");
  const id = one("id");
  const before = one("truoc");
  const q = one("q");
  return {
    entityType: type && type in ENTITY_LABEL ? type : null,
    action: action && action in ACTION_LABEL ? action : null,
    from: from && real(from) ? from : null,
    to: to && real(to) ? to : null,
    q: q ? q.slice(0, 64) : null,
    entityId: id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null,
    beforeId: before && /^\d{1,18}$/.test(before) ? Number(before) : null,
  };
}
