import { describe, expect, it } from "vitest";
import { checkReceipt, scannable, shortageNote } from "@/domain/receiving";

const items = [
  { id: "a", label: "iPhone 17 Pro", serial: "F2LXQ7Y9KD", imei1: "356938035643809", imei2: "356938035643817" },
  { id: "b", label: "iPad Air", serial: "H7K2M4N6P8", imei1: null, imei2: null },
  { id: "c", label: "AirPods", serial: null, imei1: null, imei2: null },
];

describe("checkReceipt — đối chiếu mã quét với danh sách kiện", () => {
  it("Serial / IMEI 1 / IMEI 2 đều khớp; quét nhiều mã cùng máy chỉ tính 1; giữ thứ tự danh sách kiện", () => {
    const r = checkReceipt(items, ["356938035643817", "f2lxq7y9kd", "356938035643809"]);
    expect(r.matched.map((i) => i.id)).toEqual(["a"]);
    expect(r.missing.map((i) => i.id)).toEqual(["b", "c"]);
    expect(r.outside).toEqual([]);
  });

  it("bỏ tiền tố S của mã vạch Serial; mã ngoài kiện bỏ trùng, giữ thứ tự quét", () => {
    const r = checkReceipt(items, ["SH7K2M4N6P8", "ZZZ999", "AAA111", "ZZZ999"]);
    expect(r.matched.map((i) => i.id)).toEqual(["b"]);
    expect(r.outside).toEqual(["ZZZ999", "AAA111"]);
  });

  it("chưa quét gì → mọi máy còn thiếu", () => {
    expect(checkReceipt(items, []).missing).toHaveLength(3);
  });

  it("máy không có mã → không đối chiếu được; mô tả sự cố rút gọn", () => {
    expect(items.map(scannable)).toEqual([true, true, false]);
    expect(shortageNote(items.slice(0, 2))).toBe("Nhận thiếu 2 máy: F2LXQ7Y9KD, H7K2M4N6P8");
    expect(shortageNote(items, 2)).toBe("Nhận thiếu 3 máy: F2LXQ7Y9KD, H7K2M4N6P8 … (+1)");
  });
});
