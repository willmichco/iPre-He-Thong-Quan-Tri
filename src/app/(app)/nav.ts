export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Giai đoạn triển khai trong docs/06 — trang chưa làm hiển thị "đang xây dựng". */
  phase: "GĐ0" | "GĐ1" | "GĐ2";
  description: string;
  /** đã dùng được (có trang riêng) */
  ready?: boolean;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: "◧", phase: "GĐ1", ready: true, description: "Vốn theo chặng, doanh thu, lãi, tồn kho, cảnh báo." },
  { href: "/quet-ma", label: "Quét mã", icon: "▌▌", phase: "GĐ0", ready: true, description: "Quét IMEI, Serial, mã máy bằng camera và hình ảnh." },
  { href: "/chuyen-hang", label: "Chuyến hàng", icon: "✈", phase: "GĐ1", ready: true, description: "Chuyến, đơn mua, máy, chi phí, lãi lỗ theo chuyến." },
  { href: "/van-chuyen", label: "Vận chuyển", icon: "⇢", phase: "GĐ1", ready: true, description: "Kiện 3 chặng, mốc thời gian, ETA, quá hạn." },
  { href: "/kho", label: "Kho máy", icon: "▤", phase: "GĐ1", ready: true, description: "Tồn kho, tuổi tồn, hồ sơ từng máy." },
  { href: "/ban-hang", label: "Bán hàng", icon: "₫", phase: "GĐ1", ready: true, description: "Bán nhanh, đặt cọc, công nợ, bảo hành." },
  { href: "/thu-chi", label: "Thu chi", icon: "⇄", phase: "GĐ2", description: "Sổ quỹ nhiều tài khoản, chuyển tiền, đối soát." },
  { href: "/bao-cao", label: "Báo cáo", icon: "▦", phase: "GĐ2", description: "Lãi lỗ theo kỳ, dòng máy, chuyến, kênh, vận chuyển, thuế." },
  { href: "/danh-muc", label: "Danh mục", icon: "☰", phase: "GĐ1", ready: true, description: "Mẫu máy, mã Part No., nơi mua, đơn vị vận chuyển, tài khoản." },
  { href: "/cai-dat", label: "Cài đặt", icon: "⚙", phase: "GĐ2", description: "Cảnh báo, phân bổ mặc định, bảo mật, sao lưu." },
];
