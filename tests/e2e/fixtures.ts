/**
 * Ảnh mẫu cho kiểm thử: ảnh chụp màn hình kiểu "Cài đặt › Giới thiệu" của iOS và khung hình camera
 * chụp nhãn hộp. Số liệu minh hoạ — không thuộc thiết bị thật nào.
 */
import type { Browser } from "@playwright/test";

export const SAMPLE = {
  part: "MDEM1LL/A",
  serial: "F2LXQ7Y9KD",
  imei1: "350000000000006",
  imei2: "350000000000014",
};

/** Phông của ảnh mẫu — đổi bằng E2E_FONT để thử độ bền OCR với phông khác (máy chạy CI không có phông Apple). */
const FONT = process.env.E2E_FONT ? `'${process.env.E2E_FONT}'` : "-apple-system,Helvetica,Arial,sans-serif";

function spaced(imei: string) {
  // iOS hiển thị IMEI dạng "35 000000 000000 6"
  return `${imei.slice(0, 2)} ${imei.slice(2, 8)} ${imei.slice(8, 14)} ${imei.slice(14)}`;
}

/** Ảnh chụp màn hình giả lập trang Giới thiệu của iPhone (PNG). */
export async function aboutScreenshot(browser: Browser, opts: { lang: "en" | "vi"; dark: boolean }): Promise<Buffer> {
  const L =
    opts.lang === "en"
      ? { title: "About", name: "Model Name", number: "Model Number", serial: "Serial Number", warranty: "Limited Warranty" }
      : { title: "Giới thiệu", name: "Tên máy", number: "Số máy", serial: "Số sê-ri", warranty: "Gói bảo hành đã hết hạn" };
  const rows: [string, string][] = [
    ["Name", "iPhone"],
    [L.name, "iPhone 16 Pro Max"],
    [L.number, SAMPLE.part],
    [L.serial, SAMPLE.serial],
    [L.warranty, "10/2027"],
    ["IMEI", spaced(SAMPLE.imei1)],
    ["IMEI2", spaced(SAMPLE.imei2)],
  ];
  const bg = opts.dark ? "#000" : "#f2f2f7";
  const card = opts.dark ? "#1c1c1e" : "#fff";
  const fg = opts.dark ? "#fff" : "#000";
  const sub = opts.dark ? "#8e8e93" : "#8a8a8e";
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: false });
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:${bg};font-family:${FONT};color:${fg}">
    <div style="padding:60px 16px 0;font-size:17px;font-weight:600;text-align:center">${L.title}</div>
    <div style="margin:24px 16px;background:${card};border-radius:10px">
      ${rows
        .map(
          ([k, v]) =>
            `<div style="display:flex;justify-content:space-between;padding:11px 16px;font-size:17px;border-bottom:0.5px solid ${opts.dark ? "#38383a" : "#c6c6c8"}"><span>${k}</span><span style="color:${sub}">${v}</span></div>`,
        )
        .join("")}
    </div></body>`);
  const png = await page.screenshot({ type: "png" });
  await page.close();
  return png;
}

/**
 * Khung hình "camera" chụp nhãn hộp mẫu: nhãn nhỏ trong khung, hơi nghiêng, hơi mờ — gần
 * với điều kiện thật (mã Code 128 mảnh). Dùng làm nguồn video giả cho Chromium (MJPEG).
 */
export async function cameraFrameJpeg(browser: Browser, labelSvgUrl: string): Promise<Buffer> {
  // Camera 1080p, nhãn chiếm phần lớn khung hình (cầm cách ~25 cm), hơi nghiêng, hơi mờ, nén JPEG
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false });
  await page.setContent(`<body style="margin:0;background:#6b6f73;display:grid;place-items:center;height:1080px;overflow:hidden">
    <img id="nhan" src="${labelSvgUrl}" style="width:640px;transform:rotate(-2deg);filter:blur(0.4px) brightness(0.96)">
  </body>`);
  await page.locator("#nhan").evaluate((img: HTMLImageElement) => img.decode());
  const jpg = await page.screenshot({ type: "jpeg", quality: 85 });
  await page.close();
  return jpg;
}

/**
 * Khung hình "camera" nhìn vào màn hình Giới thiệu của một iPhone khác: ảnh màn hình đặt nghiêng
 * nhẹ trên nền bàn, hơi mờ, ám hồng — giống ảnh chụp thật bằng máy khác.
 */
export async function cameraScreenFrameJpeg(
  browser: Browser,
  screenshotPng: Buffer,
  shake: { dx: number; dy: number; blur: number } = { dx: 0, dy: 0, blur: 0.5 },
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false });
  const src = `data:image/png;base64,${screenshotPng.toString("base64")}`;
  await page.setContent(`<body style="margin:0;background:#8a8378;display:grid;place-items:center;height:1080px;overflow:hidden">
    <div style="padding:14px;background:#111;border-radius:48px;transform:translate(${shake.dx}px,${shake.dy}px) rotate(1.5deg)">
      <img id="mh" src="${src}" style="height:1000px;border-radius:36px;display:block;filter:blur(${shake.blur}px) sepia(0.15) saturate(1.3) hue-rotate(-20deg) contrast(0.9)">
    </div>
  </body>`);
  await page.locator("#mh").evaluate((img: HTMLImageElement) => img.decode());
  const jpg = await page.screenshot({ type: "jpeg", quality: 85 });
  await page.close();
  return jpg;
}
