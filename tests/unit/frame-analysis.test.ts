import { describe, expect, it } from "vitest";
import { findTextRegion, inkLineHeight, motion, sharpness, shiftEstimate, type Gray } from "@/features/scanner/frame-analysis";

/** Ảnh tổng hợp: nền tối, khối "màn hình" có 4 dòng chữ (nét dọc ngắn sáng), thêm 1 đường viền dọc gây nhiễu. */
function synthetic(opts: { offsetX?: number; blur?: boolean } = {}): Gray {
  const width = 480;
  const height = 360;
  const data = new Uint8Array(width * height).fill(30);
  const ox = opts.offsetX ?? 0;
  for (let line = 0; line < 4; line++) {
    const y0 = 100 + line * 40;
    for (let y = y0; y < y0 + 14; y++) {
      // nhãn (trái) và giá trị (phải), cách nhau một khoảng trống
      for (let x = 120 + ox; x < 360 + ox; x++) {
        const inLabel = x < 200 + ox;
        const inValue = x > 260 + ox;
        if ((inLabel || inValue) && (x * 7 + line * 3) % 5 < 2) data[y * width + x] = 220;
      }
    }
  }
  for (let y = 0; y < height; y++) data[y * width + 40] = 255; // viền dọc mảnh
  if (opts.blur) {
    const out = new Uint8Array(data);
    for (let y = 1; y < height - 1; y++)
      for (let x = 2; x < width - 2; x++) {
        const i = y * width + x;
        out[i] = (data[i - 2] + data[i - 1] + data[i] + data[i + 1] + data[i + 2]) / 5;
      }
    return { data: out, width, height };
  }
  return { data, width, height };
}

describe("findTextRegion — tự tìm vùng văn bản", () => {
  it("khoanh đúng khối 4 dòng chữ, không bị đường viền dọc kéo lệch", () => {
    const box = findTextRegion(synthetic())!;
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThan(80);
    expect(box.x).toBeLessThan(130);
    expect(box.x + box.w).toBeGreaterThan(350);
    expect(box.y).toBeLessThan(105);
    expect(box.y + box.h).toBeGreaterThan(234);
    expect(box.h).toBeLessThan(220);
  });
  it("ảnh không có chữ → không có vùng", () => {
    const blank = { data: new Uint8Array(480 * 360).fill(90), width: 480, height: 360 };
    expect(findTextRegion(blank)).toBeNull();
  });
});

describe("motion / sharpness — phát hiện rung và nhòe", () => {
  it("khung giống hệt → motion = 0; dịch 12px → motion lớn (đo trong vùng chữ)", () => {
    const a = synthetic();
    const box = findTextRegion(a)!;
    expect(motion(a, synthetic(), box)).toBe(0);
    expect(motion(a, synthetic({ offsetX: 12 }), box)).toBeGreaterThan(3.5); // ngưỡng "đứng yên" của bộ quét
  });
  it("ảnh nhòe có độ nét thấp hơn hẳn ảnh nét", () => {
    expect(sharpness(synthetic())).toBeGreaterThan(3 * sharpness(synthetic({ blur: true })));
  });
});

describe("findTextRegion — màn hình Giới thiệu: nhãn bên trái, giá trị căn phải cách xa", () => {
  it("vùng chữ bao cả cột nhãn lẫn cột giá trị", () => {
    const width = 480;
    const height = 360;
    const data = new Uint8Array(width * height).fill(245); // nền sáng
    for (let line = 0; line < 5; line++) {
      const y0 = 80 + line * 40;
      for (let y = y0; y < y0 + 12; y++) {
        for (let x = 40; x < 130; x++) if (x % 5 < 2) data[y * width + x] = 20; // nhãn (đen)
        for (let x = 330; x < 440; x++) if (x % 5 < 2) data[y * width + x] = 120; // giá trị (xám nhạt, căn phải)
      }
    }
    const box = findTextRegion({ data, width, height })!;
    expect(box.x).toBeLessThan(45);
    expect(box.x + box.w).toBeGreaterThan(435);
  });
});

describe("shiftEstimate — rung tính theo độ dịch (px), không theo độ tương phản", () => {
  /** "chữ" mềm: sóng sin 2 chiều, biên độ tuỳ chọn; dịch theo phân số pixel */
  function texture(amp: number, dx = 0): Gray {
    const width = 200;
    const height = 120;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) data[y * width + x] = Math.round(128 + amp * Math.sin((x + dx) / 2.2) * Math.cos(y / 3.1));
    return { data, width, height };
  }
  const box = { x: 10, y: 10, w: 180, h: 100 };
  it("tay rung nhẹ (0,3 px) trên chữ tương phản cao vẫn là đứng yên, dù chênh lệch độ sáng vượt ngưỡng cũ 3,5", () => {
    const a = texture(120);
    const b = texture(120, 0.3);
    expect(motion(a, b, box)).toBeGreaterThan(3.5);
    expect(shiftEstimate(a, b, box)).toBeLessThan(0.6);
  });
  it("dịch 2 px → vượt ngưỡng, bất kể chữ đậm hay nhạt", () => {
    expect(shiftEstimate(texture(120), texture(120, 2), box)).toBeGreaterThan(0.6);
    expect(shiftEstimate(texture(25), texture(25, 2), box)).toBeGreaterThan(0.6);
  });
  it("khung giống hệt → 0", () => {
    expect(shiftEstimate(texture(80), texture(80), box)).toBe(0);
  });
});

describe("inkLineHeight — đo chiều cao nét chữ để thu/phóng ảnh trước khi đọc", () => {
  /** các dòng "chữ" (nét dọc) cao h px, cách nhau 3h, nghiêng `tilt` px trên toàn bề ngang */
  function lines(h: number, tilt = 0): Gray {
    const width = 900;
    const height = 12 * h;
    const data = new Uint8Array(width * height).fill(235);
    for (let line = 0; line < 3; line++) {
      for (let x = 20; x < width - 20; x++) {
        if (x % 9 > 2 || (x > 300 && x < 520)) continue; // nét chữ, khoảng trống giữa nhãn và giá trị
        const y0 = h + line * 3 * h + Math.round((tilt * x) / width);
        for (let y = y0; y < y0 + h; y++) data[y * width + x] = 25;
      }
    }
    return { data, width, height };
  }
  it("đo đúng chữ nhỏ (14 px) và chữ lớn của camera 4K (60 px)", () => {
    expect(inkLineHeight(lines(14))).toBeGreaterThanOrEqual(13);
    expect(inkLineHeight(lines(14))).toBeLessThanOrEqual(16);
    expect(inkLineHeight(lines(60))).toBeGreaterThanOrEqual(58);
    expect(inkLineHeight(lines(60))).toBeLessThanOrEqual(64);
  });
  it("ảnh nghiêng (lệch 30 px trên bề ngang) không làm phồng chiều cao quá 25%", () => {
    expect(inkLineHeight(lines(40, 30))).toBeLessThanOrEqual(50);
  });
  it("ảnh trơn, không có chữ → 0", () => {
    expect(inkLineHeight({ data: new Uint8Array(400 * 200).fill(128), width: 400, height: 200 })).toBe(0);
  });
});
