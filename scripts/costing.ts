/**
 * Giá vốn từ dòng lệnh.
 *
 *   npm run costing:check                    # mọi chuyến: giá vốn đang lưu có khớp bộ máy không (không ghi gì)
 *   npm run costing:recalc -- CH-2026-011    # tính lại một/nhiều chuyến theo mã (chuyến đã chốt mà bị đổi → báo lỗi)
 *
 * Mã thoát ≠ 0 khi lệch (check) hoặc lỗi (recalc) — CI dùng lệnh check sau bước nạp dữ liệu ví dụ.
 */
import postgres from "postgres";
import { CostingError, formatVnd } from "@/domain/costing";
import { checkAllBatches, CostingServiceError, recalculateBatches, type RecalcResult } from "@/server/costing/service";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (xem .env.example).");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const [cmd, ...args] = process.argv.slice(2);

function print(r: RecalcResult): number {
  let changed = 0;
  for (const b of r.batches) {
    const n = b.inserted + b.updated + b.deleted;
    changed += n;
    const delta = b.afterVnd - b.beforeVnd;
    console.log(
      `${n ? "✗" : "✓"} ${b.code} [${b.status}] giá vốn ${formatVnd(b.afterVnd)}` +
        (n ? ` — lệch ${n} dòng (+${b.inserted} ~${b.updated} −${b.deleted}), chênh ${formatVnd(delta)}` : ""),
    );
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w.message}`);
  return changed;
}

async function main() {
  if (cmd === "check") {
    const results = await checkAllBatches(sql);
    const changed = results.reduce((n, r) => n + print(r), 0);
    if (!results.length) console.log("Chưa có chuyến nào.");
    if (changed) {
      console.error(`✗ ${changed} dòng giá vốn đang lưu không khớp bộ máy — chạy: npm run costing:recalc -- <mã chuyến>`);
      process.exitCode = 1;
    } else console.log("✓ Giá vốn đang lưu khớp bộ máy tính giá vốn.");
    return;
  }
  if (cmd === "recalc" && args.length) {
    const rows = await sql<{ id: string; code: string }[]>`SELECT id::text, code FROM batches WHERE code = ANY(${args})`;
    const unknown = args.filter((c) => !rows.some((r) => r.code === c));
    if (unknown.length) throw new Error(`Không có chuyến: ${unknown.join(", ")}`);
    const r = await recalculateBatches(
      sql,
      rows.map((r) => r.id),
    );
    print(r);
    console.log("✓ Đã ghi giá vốn.");
    return;
  }
  console.error("Dùng: costing.ts check | costing.ts recalc <mã chuyến>…");
  process.exitCode = 2;
}

main()
  .catch((e) => {
    if (e instanceof CostingError || e instanceof CostingServiceError) console.error(`✗ [${e.code}] ${e.message}`);
    else console.error("✗", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
