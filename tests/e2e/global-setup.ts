/**
 * Tạo video giả cho camera (MJPEG) từ nhãn hộp mẫu, trước khi Chromium khởi động
 * với cờ --use-file-for-fake-video-capture.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { aboutScreenshot, cameraFrameJpeg, cameraScreenFrameJpeg } from "./fixtures";

export const FAKE_CAMERA_FILE = join(process.cwd(), ".e2e-fixtures", "camera-nhan-mau.mjpeg");
export const FAKE_SCREEN_CAMERA_FILE = join(process.cwd(), ".e2e-fixtures", "camera-man-hinh.mjpeg");

export default async function globalSetup() {
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  try {
    const svg = readFileSync(join(process.cwd(), "public", "nhan-mau.svg")).toString("base64");
    const frame = await cameraFrameJpeg(browser, `data:image/svg+xml;base64,${svg}`);
    mkdirSync(join(process.cwd(), ".e2e-fixtures"), { recursive: true });
    writeFileSync(FAKE_CAMERA_FILE, Buffer.concat(Array.from({ length: 30 }, () => frame)));
    // Màn hình máy (tiếng Việt, chế độ tối như iOS mới) + TAY RUNG: 12 khung lệch/nhòe rồi 18 khung yên, lặp lại
    const shot = await aboutScreenshot(browser, { lang: "vi", dark: true });
    const shaky = [];
    for (let i = 0; i < 12; i++) shaky.push(await cameraScreenFrameJpeg(browser, shot, { dx: ((i * 37) % 41) - 20, dy: ((i * 23) % 31) - 15, blur: 3 }));
    const steady = await cameraScreenFrameJpeg(browser, shot);
    writeFileSync(FAKE_SCREEN_CAMERA_FILE, Buffer.concat([...shaky, ...Array.from({ length: 18 }, () => steady)]));
  } finally {
    await browser.close();
  }
}
