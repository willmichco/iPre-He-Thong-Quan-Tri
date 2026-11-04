import { describe, expect, it } from "vitest";
import { addReading, emptyVotes, isDeviceComplete } from "@/domain/screen-votes";
import type { TextExtraction } from "@/domain/text-extract";

const read = (p: Partial<TextExtraction>): TextExtraction => ({ serialAnchored: true, imeis: [], ...p });

describe("bỏ phiếu giữa các lần chụp", () => {
  it("serial chỉ được nhận khi 2 lần đọc giống hệt; lần đọc sai lẻ tẻ bị bỏ qua", () => {
    let v = emptyVotes();
    let r = addReading(v, read({ serial: "F2LXQ7Y9KD" }));
    expect(r.newly.serial).toBeUndefined();
    v = r.votes;
    r = addReading(v, read({ serial: "F2LXQ7Y9K0" })); // đọc sai 1 ký tự
    expect(r.newly.serial).toBeUndefined();
    v = r.votes;
    r = addReading(v, read({ serial: "F2LXQ7Y9KD" }));
    expect(r.newly.serial).toBe("F2LXQ7Y9KD");
    expect(r.otherDevice).toBe(false);
  });

  it("IMEI (đã qua Luhn) được nhận ngay; Part No. cần 2 lần", () => {
    const r1 = addReading(emptyVotes(), read({ imeis: ["350000000000006"], partNumber: "MDEM1LL/A" }));
    expect(r1.newly.imeis).toEqual(["350000000000006"]);
    expect(r1.newly.partNumber).toBeUndefined();
    const r2 = addReading(r1.votes, read({ imeis: ["350000000000006", "350000000000014"], partNumber: "MDEM1LL/A" }));
    expect(r2.newly.imeis).toEqual(["350000000000014"]);
    expect(r2.newly.partNumber).toBe("MDEM1LL/A");
  });

  it("serial không có nhãn neo chỉ tính nửa phiếu", () => {
    let v = emptyVotes();
    for (let i = 0; i < 3; i++) v = addReading(v, read({ serial: "F2LXQ7Y9KD", serialAnchored: false })).votes;
    expect(v.accepted.serial).toBeUndefined();
    expect(addReading(v, read({ serial: "F2LXQ7Y9KD", serialAnchored: false })).newly.serial).toBe("F2LXQ7Y9KD");
  });

  it("đã chốt serial mà gặp serial khác (2 lần) → báo sang máy khác", () => {
    let v = emptyVotes();
    v = addReading(v, read({ serial: "F2LXQ7Y9KD" })).votes;
    v = addReading(v, read({ serial: "F2LXQ7Y9KD" })).votes;
    v = addReading(v, read({ serial: "C02XL0GTJGH5" })).votes;
    expect(addReading(v, read({ serial: "C02XL0GTJGH5" })).otherDevice).toBe(true);
  });

  it("IMEI thứ ba → máy khác", () => {
    let v = addReading(emptyVotes(), read({ imeis: ["350000000000006", "350000000000014"] })).votes;
    expect(addReading(v, read({ imeis: ["490154203237518"] })).otherDevice).toBe(true);
    v = addReading(v, read({ imeis: ["350000000000006"] })).votes;
    expect(v.accepted.imeis).toHaveLength(2);
  });
});

describe("isDeviceComplete — đủ thông tin thì camera tự dừng", () => {
  const full = { serial: "F2LXQ7Y9KD", partNumber: "MDEM1LL/A", imeis: ["350000000000006", "350000000000014"] };
  it("Serial + Part No. + 2 IMEI → xong ngay", () => {
    expect(isDeviceComplete(full, 0)).toBe(true);
  });
  it("chưa có Serial → chưa xong, dù đọc mãi", () => {
    expect(isDeviceComplete({ imeis: full.imeis, partNumber: full.partNumber }, 9)).toBe(false);
  });
  it("1 IMEI: đọc thêm 1 lần không thấy IMEI 2 → xong", () => {
    const one = { ...full, imeis: [full.imeis[0]] };
    expect(isDeviceComplete(one, 0)).toBe(false);
    expect(isDeviceComplete(one, 1)).toBe(true);
  });
  it("iPad Wi-Fi (không IMEI) / Part No. chưa khớp → sau 2 lần không có gì mới (3 nếu còn giá trị chờ)", () => {
    const s = { serial: full.serial, imeis: [] };
    expect(isDeviceComplete(s, 1)).toBe(false);
    expect(isDeviceComplete(s, 2)).toBe(true);
    expect(isDeviceComplete(s, 2, 1)).toBe(false);
    expect(isDeviceComplete(s, 3, 1)).toBe(true);
  });
});
