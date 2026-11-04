import { scryptSync } from "node:crypto";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Kiểm thử đầu-cuối chạy trên bản build production (next start) với một tài khoản
 * chủ dành riêng cho kiểm thử. Giá trị cố định để mọi worker dùng chung.
 */
export const E2E_OWNER = {
  email: "kiem-thu@ipre.local",
  password: "mat-khau-kiem-thu-2026",
  totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
};

const salt = Buffer.from("ipre-e2e-salt-01");
const hash = scryptSync(E2E_OWNER.password.normalize("NFKC"), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const passwordHash = ["scrypt", 2 ** 15, 8, 1, salt.toString("base64"), hash.toString("base64")].join("$");

const PORT = 3100;
const FAKE_CAMERA_FILE = join(process.cwd(), ".e2e-fixtures", "camera-nhan-mau.mjpeg");
const FAKE_SCREEN_CAMERA_FILE = join(process.cwd(), ".e2e-fixtures", "camera-man-hinh.mjpeg");
const fakeCamera = (file: string) => ({
  ...devices["Desktop Chrome"],
  permissions: ["camera"],
  launchOptions: {
    ...chromiumPath,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${file}`],
  },
});
const chromiumPath = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    // Máy có sẵn Chromium khác phiên bản: đặt PW_CHROMIUM_PATH=/đường/dẫn/chrome
    launchOptions: chromiumPath,
  },
  projects: [
    { name: "desktop", testIgnore: /camera-/, use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", testIgnore: /camera-/, use: { ...devices["iPhone 15"], browserName: "chromium" } },
    // Camera giả (tạo trong global-setup): dạng 2 = sau hộp, dạng 1 = màn hình Giới thiệu của máy
    { name: "camera-hop", testMatch: /camera-hop\.spec/, use: fakeCamera(FAKE_CAMERA_FILE) },
    { name: "camera-man-hinh", testMatch: /camera-man-hinh\.spec/, use: fakeCamera(FAKE_SCREEN_CAMERA_FILE) },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      OWNER_EMAIL: E2E_OWNER.email,
      OWNER_PASSWORD_HASH: passwordHash,
      OWNER_TOTP_SECRET: E2E_OWNER.totpSecret,
      SESSION_SECRET: "e2e-session-secret-khong-dung-cho-moi-truong-that-0123456789",
    },
  },
});
