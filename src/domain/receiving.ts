/**
 * Nhận kiện bằng quét đối chiếu (tài liệu 07 mục 5.1) — phần thuần.
 *
 * Quét từng hộp khi kiện về → so với danh sách máy đã gửi trong kiện:
 *  ✓ khớp      — máy có trong kiện và đã quét (Serial, IMEI 1 hoặc IMEI 2 đều được; quét cả Serial lẫn IMEI chỉ tính 1 máy)
 *  ○ còn thiếu — máy có trong kiện nhưng chưa quét → khi xác nhận: giữ trạng thái đang vận chuyển + ghi sự cố thiếu hàng
 *  ⚠ ngoài kiện — mã quét không thuộc kiện (gửi nhầm kiện / máy chưa nhập) → không làm gì, chỉ cảnh báo
 */
import { parseScanList } from "./shipping";

export interface ExpectedItem {
  id: string;
  label: string;
  serial: string | null;
  imei1: string | null;
  imei2: string | null;
}

export interface ReceiptCheck<T extends ExpectedItem = ExpectedItem> {
  matched: T[];
  missing: T[];
  /** mã quét không thuộc máy nào trong kiện (đã bỏ trùng, giữ thứ tự quét) */
  outside: string[];
}

const norm = (c: string | null) => (c ? c.trim().toUpperCase() : null);

/** Mã quét → máy nào trong kiện. Mã được chuẩn hoá như ô quét vào kiện (bỏ tiền tố "S" của mã vạch Serial…). */
export function checkReceipt<T extends ExpectedItem>(expected: readonly T[], scanned: readonly string[]): ReceiptCheck<T> {
  const byCode = new Map<string, T>();
  for (const it of expected) for (const c of [it.serial, it.imei1, it.imei2].map(norm)) if (c) byCode.set(c, it);
  const hit = new Set<string>();
  const outside: string[] = [];
  for (const code of parseScanList(scanned.join("\n"))) {
    const it = byCode.get(code);
    if (it) hit.add(it.id);
    else if (!outside.includes(code)) outside.push(code);
  }
  return { matched: expected.filter((i) => hit.has(i.id)), missing: expected.filter((i) => !hit.has(i.id)), outside };
}

/** Máy không có Serial lẫn IMEI thì không đối chiếu bằng quét được (vd đặt hàng chưa biết serial). */
export const scannable = (i: ExpectedItem) => Boolean(i.serial || i.imei1 || i.imei2);

/** Dòng mô tả sự cố thiếu hàng ghi vào nhật ký kiện. */
export function shortageNote(missing: readonly ExpectedItem[], max = 10): string {
  const ids = missing.map((m) => m.serial ?? m.imei1 ?? m.imei2 ?? m.label);
  const shown = ids.slice(0, max).join(", ");
  return `Nhận thiếu ${missing.length} máy: ${shown}${ids.length > max ? ` … (+${ids.length - max})` : ""}`;
}
