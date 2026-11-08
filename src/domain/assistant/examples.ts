/**
 * Trợ lý — câu mẫu, lời chào, gợi ý khi chưa hiểu. Thuần, dùng chung trình duyệt + máy chủ.
 */
import type { Chip, Reply } from "./reply";

export const QUICK_CHIPS: Chip[] = [
  { label: "Tồn kho", text: "tồn kho" },
  { label: "Doanh thu tháng này", text: "doanh thu tháng này" },
  { label: "Ai còn nợ", text: "ai còn nợ" },
  { label: "Kiện đang đi", text: "kiện đang đi" },
  { label: "Cần xử lý", text: "có gì cần xử lý" },
  { label: "Xuất Excel tháng này", text: "xuất excel tháng này" },
];

/** Mẫu câu theo nhóm — hiện ở trang trợ giúp và khi bot chưa hiểu. */
export const EXAMPLES: { group: string; items: string[] }[] = [
  {
    group: "Bán hàng",
    items: [
      "bán 3567 8901 2345 672 cho chị Lan 0901234567 25tr5 zalo ck",
      "bán pro max 256 cho anh Nam 25tr hôm qua tiền mặt bh 12 tháng",
      "chị Hoa cọc 5tr máy đuôi 5672 giá 26tr",
      "chị Lan trả thêm 3tr ck · hoàn tất đơn BH-2026-0012",
      "hoá đơn BH-2026-0012 số 0001234 · đặt giá máy đuôi 5672 27tr",
    ],
  },
  {
    group: "Nhập hàng & chi phí",
    items: [
      "nhập máy pro max 256 $999 vào CH-2026-012 imei 356789012345672",
      "cước kiện 1Z999AA10123456784 3tr5 · phí thông quan CH-2026-012 2tr",
      "chi quảng cáo fb 2tr hôm qua tiền mặt · góp vốn 100tr vcb",
      "chuyển 10tr từ tiền mặt sang vcb · thêm khách chị Lan 0901234567",
    ],
  },
  {
    group: "Hỏi",
    items: [
      "tồn kho · còn mấy con pro max 256 · máy tồn trên 45 ngày",
      "doanh thu tháng này · lãi quý 3 · doanh thu từng tháng năm nay",
      "dòng nào lãi nhất · kênh nào bán nhiều · chuyến CH-2026-011 lãi bao nhiêu",
      "ai còn nợ · tiền mặt còn bao nhiêu · thu chi tuần này",
      "kiện đang đi · kiện nào trễ · kiện nào thiếu máy · có gì cần xử lý",
      "sắp chạm ngưỡng thuế chưa · đơn nào chưa xuất hoá đơn",
      "gõ IMEI / Serial / BH-… / CH-… / mã vận đơn để tra",
    ],
  },
  { group: "Bảng kê & Excel", items: ["xuất excel tháng này · xuất bảng kê quý 3 · bảng kê nháp"] },
];

export function helpReply(): Reply {
  return {
    text:
      "Mình là trợ lý nhập liệu của iPre. Nhắn tự nhiên như nhắn cho người làm: mình đọc máy, IMEI, giá, khách, ngày, kênh, " +
      "thanh toán rồi lập phiếu để bạn bấm Xác nhận — không có gì được ghi khi chưa bấm. Tin chưa đủ thông tin sẽ vào Bảng kê nháp để bổ sung sau.",
    cards: EXAMPLES.map((g) => ({ kind: "table" as const, title: g.group, columns: ["Ví dụ"], rows: g.items.map((i) => [i]) })),
    chips: QUICK_CHIPS,
  };
}

/** Khi chưa hiểu: gợi ý theo các từ đã nhận ra (tiền, ngày, máy…). */
export function fallbackReply(hint: { money: boolean; date: boolean; product: boolean; code: boolean }): Reply {
  const chips: Chip[] = [];
  if (hint.code) chips.push({ label: "Tra máy này", text: "tra" });
  if (hint.product) chips.push({ label: "Còn mấy máy dòng này", text: "tồn kho" });
  if (hint.money) chips.push({ label: "Ghi bán máy…", text: "giúp" }, { label: "Ghi chi phí…", text: "giúp" });
  if (hint.date) chips.push({ label: "Doanh thu kỳ này", text: "doanh thu tháng này" });
  return {
    text:
      'Mình chưa hiểu ý bạn. Thử nhắn theo mẫu, ví dụ: "bán <IMEI> 25tr cho chị Lan ck", "chi quảng cáo 2tr hôm qua", "tồn kho", "doanh thu tháng này". ' +
      'Gõ "giúp" để xem đủ các câu mình làm được.',
    chips: [...chips.filter((c) => c.text !== "giúp"), { label: "Xem câu mẫu", text: "giúp" }, ...QUICK_CHIPS.slice(0, 4)].slice(0, 7),
  };
}
