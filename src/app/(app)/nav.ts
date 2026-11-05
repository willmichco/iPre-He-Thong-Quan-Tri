import type { IconName } from "./_components/NavIcon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Giai đoạn triển khai trong docs/06. */
  phase: "GĐ0" | "GĐ1" | "GĐ2";
  description: string;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: "overview", phase: "GĐ1", description: "Vốn theo chặng, doanh thu, lãi, tồn kho, cảnh báo." },
  { href: "/quet-ma", label: "Quét mã", icon: "scan", phase: "GĐ0", description: "Quét IMEI, Serial, mã máy bằng camera và hình ảnh." },
  { href: "/chuyen-hang", label: "Chuyến hàng", icon: "batch", phase: "GĐ1", description: "Chuyến, đơn mua, máy, chi phí, lãi lỗ theo chuyến." },
  { href: "/van-chuyen", label: "Vận chuyển", icon: "truck", phase: "GĐ1", description: "Kiện 3 chặng, mốc thời gian, ETA, quá hạn." },
  { href: "/kho", label: "Kho máy", icon: "stock", phase: "GĐ1", description: "Tồn kho, tuổi tồn, hồ sơ từng máy." },
  { href: "/ban-hang", label: "Bán hàng", icon: "sale", phase: "GĐ1", description: "Bán nhanh, đặt cọc, công nợ, bảo hành." },
  { href: "/thu-chi", label: "Thu chi", icon: "cash", phase: "GĐ2", description: "Sổ quỹ nhiều tài khoản, chuyển tiền, đối soát." },
  { href: "/bao-cao", label: "Báo cáo", icon: "report", phase: "GĐ2", description: "Lãi lỗ theo kỳ, dòng máy, chuyến, kênh, vận chuyển, thuế." },
  {
    href: "/danh-muc",
    label: "Danh mục",
    icon: "catalog",
    phase: "GĐ1",

    description: "Mẫu máy, mã Part No., nơi mua, đơn vị vận chuyển, tài khoản.",
  },
  { href: "/cai-dat", label: "Cài đặt", icon: "settings", phase: "GĐ2", description: "Cảnh báo, phân bổ mặc định, bảo mật, sao lưu." },
];
