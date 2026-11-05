/**
 * Dựng biểu tượng PNG cho ứng dụng cài trên điện thoại (PWA) từ public/icons/icon.svg bằng Chromium (Playwright).
 *   node scripts/make-icons.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const svg = readFileSync(join(process.cwd(), "public/icons/icon.svg"), "utf8");
const out = (n) => join(process.cwd(), "public/icons", n);
// any: bo góc sẵn (trình duyệt máy tính, Android cũ); maskable: phủ kín, hệ điều hành tự cắt; apple-touch: iOS tự bo góc
const targets = [
  { file: "icon-192.png", size: 192, radius: 0.22 },
  { file: "icon-512.png", size: 512, radius: 0.22 },
  { file: "maskable-512.png", size: 512, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, radius: 0 },
];
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${t.size}px;height:${t.size}px;border-radius:${t.radius * t.size}px;overflow:hidden">${svg.replace("<svg ", `<svg width="${t.size}" height="${t.size}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: out(t.file), omitBackground: true });
  console.log(`✓ public/icons/${t.file}`);
}
await browser.close();
