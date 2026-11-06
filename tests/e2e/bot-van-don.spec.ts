import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { login } from "./helpers";

/**
 * Bot theo dõi vận đơn: dán link UPS → tự nhận hãng, tạo kiện, mở trang kiện; nhập giờ tạo nhãn theo giờ Arizona → hiện giờ VN;
 * thẻ bot trên Tổng quan. CI không có khoá API của hãng → bot báo "chưa có khoá". Dọn sạch ở cuối.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Bot vận đơn cần DATABASE_URL");

/** Mã UPS 1Z ngẫu nhiên, đúng số kiểm tra (không phải vận đơn thật). */
function randomUps() {
  const chars = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";
  const body = Array.from({ length: 15 }, (_, i) => (i < 6 ? chars[Math.floor(Math.random() * chars.length)] : String(Math.floor(Math.random() * 10)))).join(
    "",
  );
  let sum = 0;
  [...body].forEach((c, i) => {
    const v = /\d/.test(c) ? Number(c) : (c.charCodeAt(0) - 63) % 10;
    sum += i % 2 === 1 ? v * 2 : v;
  });
  return `1Z${body}${(10 - (sum % 10)) % 10}`;
}

test("dán link UPS → bot tạo kiện + theo dõi; giờ Arizona → giờ VN; thẻ bot ở Tổng quan", async ({ page }) => {
  test.setTimeout(60_000);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const no = randomUps();
  try {
    await login(page);
    await page.goto("/van-chuyen");
    await page.getByLabel("Link tra cứu hoặc mã vận đơn").fill(`https://www.ups.com/track?track=yes&trackNums=${no}&loc=en_US&requester=ST/trackdetails`);
    await page.getByRole("button", { name: "Theo dõi" }).click();
    await expect(page).toHaveURL(/\/van-chuyen\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(no);
    const panel = page.getByTestId("bot-panel");
    await expect(panel).toContainText("Bot theo dõi vận đơn");
    await expect(panel.getByRole("note")).toContainText("Chưa có khoá API để theo dõi UPS");

    // người bán tạo nhãn 02/11 21:56 giờ Arizona = 03/11 11:56 giờ VN
    await panel.getByText("Giờ người bán tạo nhãn").click();
    const form = page.getByRole("form", { name: "Giờ tạo nhãn" });
    await form.getByLabel("Người bán tạo nhãn lúc").fill("2026-11-02T21:56");
    await form.getByLabel("Theo giờ").selectOption("America/Phoenix");
    await form.getByRole("button", { name: "Lưu" }).click();
    await expect(form.getByRole("status")).toContainText("Đã lưu giờ người bán tạo nhãn");
    await expect(page.getByTestId("label-created")).toHaveText("03/11 11:56");

    await page.goto("/");
    const card = page.getByTestId("bot-card");
    await expect(card.getByTestId("bot-unconfigured")).toBeVisible();
    await expect(card.getByTestId("bot-row").filter({ hasText: no })).toContainText("Chưa đọc được");
    await expect(card.getByTestId("bot-run")).toContainText("Kiểm tra 07:00 và 19:00 mỗi ngày");
  } finally {
    await sql`DELETE FROM shipments WHERE tracking_number = ${no} AND status = 'PLANNED'`;
    await sql.end();
  }
});

test("cron bot: thiếu / sai khoá → từ chối", async ({ request }) => {
  const r = await request.post("/api/cron/theo-doi-van-don", { headers: { Authorization: "Bearer sai" } });
  expect([401, 503]).toContain(r.status());
});
