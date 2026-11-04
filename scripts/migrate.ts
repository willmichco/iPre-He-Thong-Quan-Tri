/**
 * Chạy migration SQL thuần trong db/migrations theo thứ tự tên file.
 * - Mỗi file chạy trong một transaction; lỗi là huỷ toàn bộ file đó.
 * - Ghi lại file đã chạy + mã băm SHA-256; file đã chạy mà bị sửa → báo lỗi (không âm thầm bỏ qua).
 *
 *   npm run db:migrate            # áp dụng migration còn thiếu
 *   npm run db:migrate -- --seed  # áp dụng + nạp dữ liệu ví dụ db/seed-vi-du.sql
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (xem .env.example).");
  process.exit(1);
}

const dir = join(process.cwd(), "db", "migrations");
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  const applied = new Map((await sql<{ name: string; sha256: string }[]>`SELECT name, sha256 FROM schema_migrations`).map((r) => [r.name, r.sha256]));

  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  let count = 0;
  for (const file of files) {
    const body = readFileSync(join(dir, file), "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    const prev = applied.get(file);
    if (prev) {
      if (prev !== hash) throw new Error(`Migration ${file} đã chạy nhưng nội dung đã bị sửa. Hãy tạo migration mới thay vì sửa file cũ.`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${file}, ${hash})`;
    });
    console.log(`✓ ${file}`);
    count++;
  }
  console.log(count ? `Đã áp dụng ${count} migration.` : "CSDL đã ở phiên bản mới nhất.");

  if (process.argv.includes("--seed")) {
    await sql.unsafe(readFileSync(join(process.cwd(), "db", "seed-vi-du.sql"), "utf8"));
    console.log("✓ Đã nạp dữ liệu ví dụ (db/seed-vi-du.sql).");
  }
}

main()
  .catch((e) => {
    console.error("✗", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
