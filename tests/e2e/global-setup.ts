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
    const screen = await cameraScreenFrameJpeg(browser, await aboutScreenshot(browser, { lang: "vi", dark: false }));
    writeFileSync(FAKE_SCREEN_CAMERA_FILE, Buffer.concat(Array.from({ length: 30 }, () => screen)));
  } finally {
    await browser.close();
  }
}
