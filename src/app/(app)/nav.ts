import type { IconName } from "./_components/NavIcon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Nhóm trên thanh bên máy tính. */
  group: "ops" | "money" | "system";
  /** Giai đoạn triển khai trong docs/06. */
  phase: "GĐ0" | "GĐ1" | "GĐ2";
  description: string;
}

export const NAV_GROUPS: Record<NavItem["group"], string> = {
  ops: "Vận hành",
  money: "Tài chính",
  system: "Hệ thống",
};

export const NAV: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: "overview", group: "ops", phase: "GĐ1", description: "Vốn theo chặng, doanh thu, lãi, tồn kho, cảnh báo." },
  {
    href: "/tro-ly",
    label: "Trợ lý",
    icon: "assistant",
    group: "ops",
    phase: "GĐ2",
    description: "Nhắn tin để ghi bán, nhập máy, thu chi; hỏi tồn kho, doanh thu, công nợ; xuất bảng kê Excel.",
  },
  { href: "/quet-ma", label: "Quét mã", icon: "scan", group: "ops", phase: "GĐ0", description: "Quét IMEI, Serial, mã máy bằng camera và hình ảnh." },
  { href: "/chuyen-hang", label: "Chuyến hàng", icon: "batch", group: "ops", phase: "GĐ1", description: "Chuyến, đơn mua, máy, chi phí, lãi lỗ theo chuyến." },
  { href: "/van-chuyen", label: "Vận chuyển", icon: "truck", group: "ops", phase: "GĐ1", description: "Kiện 3 chặng, mốc thời gian, ETA, quá hạn." },
  { href: "/kho", label: "Kho máy", icon: "stock", group: "ops", phase: "GĐ1", description: "Tồn kho, tuổi tồn, hồ sơ từng máy." },
  { href: "/ban-hang", label: "Bán hàng", icon: "sale", group: "ops", phase: "GĐ1", description: "Bán nhanh, đặt cọc, công nợ, bảo hành." },
  { href: "/thu-chi", label: "Thu chi", icon: "cash", group: "money", phase: "GĐ2", description: "Sổ quỹ nhiều tài khoản, chuyển tiền, đối soát." },
  { href: "/bao-cao", label: "Báo cáo", icon: "report", group: "money", phase: "GĐ2", description: "Lãi lỗ theo kỳ, dòng máy, chuyến, kênh, vận chuyển, thuế." },
  { href: "/danh-muc", label: "Danh mục", icon: "catalog", group: "system", phase: "GĐ1", description: "Mẫu máy, mã Part No., nơi mua, đơn vị vận chuyển, tài khoản." },
  { href: "/cai-dat", label: "Cài đặt", icon: "settings", group: "system", phase: "GĐ2", description: "Cảnh báo, phân bổ mặc định, bảo mật, sao lưu." },
];

/** Thanh tab điện thoại: 4 mục dùng hằng ngày + nút Quét ở giữa; còn lại nằm trong bảng "Thêm". */
export const TAB_BAR = ["/", "/kho", "/quet-ma", "/ban-hang"] as const;

export function isActive(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
