import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Bố cục form: trong mỗi hàng form (.field-row, hoặc form xếp hàng ngang flex-wrap), các ô nhập / nút / ô tích nằm trên CÙNG một dòng phải thẳng mép trên
 * (lệch ≤ 1px) — kể cả khi có ô kèm dòng gợi ý hoặc nhãn dài. Mở hết <details> để kiểm cả form sửa đang thu gọn.
 * Chỉ đọc, chạy trên dữ liệu ví dụ.
 */
const PAGES = [
  "/chuyen-hang",
  "/chuyen-hang/60000000-0000-0000-0000-000000000001",
  "/van-chuyen",
  "/van-chuyen/90000000-0000-0000-0000-000000000001",
  "/ban-hang/c0000000-0000-0000-0000-000000000001",
  "/danh-muc",
  "/danh-muc/ma-may?code=MYMJ3LL/A",
  "/danh-muc/noi-mua",
  "/danh-muc/van-chuyen",
  "/danh-muc/tai-khoan",
  "/thu-chi",
  "/thu-chi/tai-khoan/50000000-0000-0000-0000-000000000002",
  "/thu-chi/cong-no",
  "/thu-chi/danh-muc",
  "/bao-cao",
  "/kho/80000000-0000-0000-0000-000000000003",
  "/cai-dat",
  "/ban-hang/khach-hang",
  "/ban-hang/khach-hang/b0000000-0000-0000-0000-000000000002",
  "/quet-ma/hop-cho",
  "/cai-dat/nhat-ky",
];

test("mọi hàng form thẳng hàng (ô nhập, nút, ô tích)", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "/chuyen-hang");
  const problems: string[] = [];
  for (const u of PAGES) {
    await page.goto(u);
    await expect(page.locator("main h1")).toBeVisible();
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      const ctrlTop = (el: Element) => {
        const c = el.matches("button, a, .field-inline") ? el : el.querySelector(".field, select, textarea, input:not([type=hidden]), button");
        const r = c?.getBoundingClientRect();
        return r && r.height ? r.top : null;
      };
      document.querySelectorAll(".field-row, form.flex-wrap").forEach((row, ri) => {
        const lines: { top: number; bottom: number; items: [string, number][] }[] = [];
        for (const k of row.children) {
          const r = k.getBoundingClientRect();
          if (!r.height || k.matches("p, input[type=hidden]")) continue;
          let line = lines.find((l) => r.top < l.bottom - 4 && r.bottom > l.top + 4);
          if (!line) lines.push((line = { top: r.top, bottom: r.bottom, items: [] }));
          else {
            line.top = Math.min(line.top, r.top);
            line.bottom = Math.max(line.bottom, r.bottom);
          }
          const t = ctrlTop(k);
          if (t !== null) line.items.push([(k.textContent ?? "").trim().slice(0, 20), Math.round(t)]);
        }
        for (const l of lines) {
          const ts = l.items.map((i) => i[1]);
          if (ts.length > 1 && Math.max(...ts) - Math.min(...ts) > 1)
            out.push(`${row.getAttribute("aria-label") ?? `hàng ${ri}`}: ${l.items.map((i) => `${i[0]}@${i[1]}`).join(" | ")}`);
        }
      });
      return out;
    });
    problems.push(...bad.map((b) => `${u} — ${b}`));
  }
  expect(problems).toEqual([]);
});
