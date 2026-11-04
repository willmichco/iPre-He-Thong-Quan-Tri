import { describe, expect, it } from "vitest";
import {
  boardColumn,
  daysLate,
  etaFrom,
  isoToVnLocal,
  LEG_RULES,
  nextItemStatus,
  parseScanList,
  shipmentSchema,
  trackingUrl,
  vnLocalToIso,
} from "@/domain/shipping";
import { validate } from "@/domain/catalog";

describe("trạng thái máy theo kiện", () => {
  it("chỉ đi tới, không lùi", () => {
    expect(nextItemStatus("ORDERED", "US_IN_TRANSIT")).toBe("US_IN_TRANSIT");
    expect(nextItemStatus("ORDERED", "INTL_IN_TRANSIT")).toBe("INTL_IN_TRANSIT"); // bỏ qua chặng (gửi thẳng kho)
    expect(nextItemStatus("AT_HN", "AT_US_WAREHOUSE")).toBeNull(); // nhập bù kiện cũ: không kéo lùi
    expect(nextItemStatus("IN_STOCK", "IN_STOCK")).toBeNull();
  });
  it("khách cọc / đã bán / thất lạc… giữ nguyên", () => {
    for (const s of ["RESERVED", "SOLD", "LOST", "RETURNED_TO_SELLER", "WARRANTY"]) expect(nextItemStatus(s, "IN_STOCK")).toBeNull();
  });
  it("3 chặng → mốc M2…M7", () => {
    expect(Object.values(LEG_RULES).map((r) => [r.departMilestone, r.departEvent, r.arriveMilestone, r.arriveEvent])).toEqual([
      ["M2", "SELLER_SHIPPED", "M3", "US_WAREHOUSE_RECEIVED"],
      ["M4", "INTL_DEPARTED", "M5", "HN_ARRIVED"],
      ["M6", "DOMESTIC_DEPARTED", "M7", "SG_RECEIVED"],
    ]);
  });
  it("cột bảng tiến độ", () => {
    expect(boardColumn({ status: "PLANNED", legType: "US_TO_VN" })).toBe("PLANNED");
    expect(boardColumn({ status: "IN_TRANSIT", legType: "US_TO_VN" })).toBe("US_TO_VN");
    expect(boardColumn({ status: "HOLD", legType: "US_TO_VN" })).toBe("US_TO_VN");
    expect(boardColumn({ status: "IN_TRANSIT", legType: "SG_LOCAL" })).toBe("OTHER");
    expect(boardColumn({ status: "ARRIVED", legType: "HN_TO_SG" })).toBe("ARRIVED");
    expect(boardColumn({ status: "CANCELLED", legType: "HN_TO_SG" })).toBeNull();
  });
});

describe("ngày giờ, ETA, trễ hạn", () => {
  it("ô datetime-local (giờ VN) ↔ ISO", () => {
    expect(vnLocalToIso("2026-11-04T09:30")).toBe("2026-11-04T09:30:00+07:00");
    expect(vnLocalToIso("2026-11-04T09:30:15")).toBe("2026-11-04T09:30:00+07:00");
    expect(vnLocalToIso("04/11/2026 09:30")).toBeNull();
    expect(vnLocalToIso("2026-13-45T99:99")).toBeNull();
    expect(isoToVnLocal(new Date("2026-11-04T20:30:00Z"))).toBe("2026-11-05T03:30");
  });
  it("ETA = ngày gửi (theo giờ VN) + số ngày giao", () => {
    expect(etaFrom("2026-10-08T12:00:00+07:00", 9)).toBe("2026-10-17");
    expect(etaFrom("2026-10-31T23:30:00Z", 1)).toBe("2026-11-02"); // 06:30 ngày 01/11 giờ VN
    expect(etaFrom("2026-10-08T12:00:00+07:00", null)).toBeNull();
  });
  it("số ngày trễ chỉ tính cho kiện đang đi / giữ hải quan", () => {
    expect(daysLate("2026-11-01", "2026-11-04", "IN_TRANSIT")).toBe(3);
    expect(daysLate("2026-11-01", "2026-11-04", "HOLD")).toBe(3);
    expect(daysLate("2026-11-05", "2026-11-04", "IN_TRANSIT")).toBe(0);
    expect(daysLate("2026-11-01", "2026-11-04", "ARRIVED")).toBe(0);
    expect(daysLate(null, "2026-11-04", "IN_TRANSIT")).toBe(0);
  });
  it("link tra vận đơn", () => {
    expect(trackingUrl("https://t.test/?n={tracking}", "9400 11")).toBe("https://t.test/?n=9400%2011");
    expect(trackingUrl(null, "x")).toBeNull();
    expect(trackingUrl("https://t.test/{tracking}", null)).toBeNull();
  });
});

describe("quét / dán mã & form kiện", () => {
  it("tách mã, bỏ trùng, bỏ tiền tố S của mã vạch serial", () => {
    expect(parseScanList(" sF2LXQ7Y9KD\n350000000000006, 350000000000006;F2LXQ7Y9KD | SERIALIPHONE01 ")).toEqual([
      "F2LXQ7Y9KD",
      "350000000000006",
      "SERIALIPHONE01",
    ]);
    expect(parseScanList("S12345678901")).toEqual(["S12345678901"]); // toàn số sau S: không phải mã vạch serial
    expect(parseScanList("  ")).toEqual([]);
  });
  it("form kiện", () => {
    expect(validate(shipmentSchema, { legType: "US_TO_VN", trackingNumber: "1z 999 aa", chargeableWeightKg: "2,4", eta: "2026-11-20" })).toEqual({
      ok: true,
      data: {
        legType: "US_TO_VN",
        carrierId: null,
        batchId: null,
        trackingNumber: "1Z999AA",
        referenceCode: null,
        eta: "2026-11-20",
        chargeableWeightKg: "2.400",
        note: null,
      },
    });
    expect(validate(shipmentSchema, { legType: "BAY", carrierId: "x", eta: "20/11", chargeableWeightKg: "0" })).toEqual({
      ok: false,
      errors: {
        legType: "Chọn chặng",
        carrierId: "Lựa chọn không hợp lệ",
        eta: "Ngày dự kiến không hợp lệ",
        chargeableWeightKg: "Cân nặng tính cước không hợp lệ",
      },
    });
  });
});
