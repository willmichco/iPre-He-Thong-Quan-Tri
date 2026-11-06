/**
 * Bot theo dõi vận đơn — chạy một lượt từ dòng lệnh (cron của máy chủ).
 *
 *   npm run tracking
 *
 * Lịch gợi ý 07:00 và 19:00 giờ VN (= 00:00 và 12:00 UTC):   0 0,12 * * *  cd /srv/ipre && npm run tracking
 * Biến môi trường: DATABASE_URL; khoá hãng UPS_CLIENT_ID + UPS_CLIENT_SECRET và / hoặc TRACK17_API_KEY.
 */
import postgres from "postgres";
import { runTrackingBot } from "../src/server/tracking/service";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Thiếu DATABASE_URL.");
    process.exit(1);
  }
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  try {
    const r = await runTrackingBot(sql, { trigger: "SCHEDULE" });
    if (r.skipped) console.log("Bot đang chạy ở tiến trình khác — bỏ qua lượt này.");
    else
      console.log(
        `✓ Đã kiểm tra ${r.checked} kiện · ${r.changed} có cập nhật mới · ${r.failed} lỗi${r.unconfigured ? ` · ${r.unconfigured} kiện chưa có nguồn dữ liệu` : ""}`,
      );
    if (r.failed) process.exitCode = 2;
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
