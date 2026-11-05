import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Ứng dụng cài được (PWA): tệp cài đặt tải được khi chưa đăng nhập; mất mạng → trang báo, không bao giờ hiện số liệu cũ. */
test("manifest, biểu tượng, service worker, trang mất kết nối — không cần đăng nhập", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.ok()).toBe(true);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ short_name: "iPre", start_url: "/", display: "standalone", lang: "vi" });
  expect(manifest.icons.map((i: { purpose: string }) => i.purpose)).toEqual(["any", "any", "maskable"]);
  for (const i of manifest.icons) expect((await request.get(i.src)).headers()["content-type"]).toBe("image/png");
  const sw = await request.get("/sw.js");
  expect(sw.headers()["content-type"]).toContain("application/javascript");
  expect(sw.headers()["cache-control"]).toContain("no-store");
  expect(await sw.text()).toContain('req.method !== "GET"');
  expect(await (await request.get("/offline.html")).text()).toContain("Mất kết nối mạng");
});

test("service worker chạy; mất mạng → trang 'Mất kết nối', có mạng lại → số liệu mới", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "service worker trong Playwright: Chromium");
  await login(page, "/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await context.setOffline(true);
  await page.goto("/kho").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Mất kết nối mạng" })).toBeVisible();
  await expect(page.getByText("Kho máy")).toHaveCount(0); // không có trang cũ đã lưu
  // có mạng lại: trang tự tải lại (sự kiện "online"); trình duyệt giả lập không phát sự kiện thì tải lại tay
  await context.setOffline(false);
  const heading = page.getByRole("heading", { name: "Kho máy", level: 1 });
  if (!(await heading.isVisible({ timeout: 0 }).catch(() => false))) {
    await heading.waitFor({ timeout: 5_000 }).catch(() => page.reload());
  }
  await expect(heading).toBeVisible();
});
