/**
 * Sao lưu / kiểm tra / khôi phục / dọn bản cũ.
 *
 *   npm run backup                                   # tạo bản sao lưu mã hoá + dọn bản cũ (30 ngày + 12 tháng)
 *   npm run backup -- kiem-tra <tệp.ipbak>           # giải mã + kiểm tra toàn vẹn, không ghi gì
 *   npm run backup -- khoi-phuc <tệp.ipbak> --vao <DATABASE_URL đích> --dong-y-ghi-de
 *
 * Biến môi trường: DATABASE_URL, BACKUP_KEY (bắt buộc, ≥ 16 ký tự — mất khoá là mất bản sao lưu),
 * BACKUP_DIR (mặc định ./data/sao-luu), ATTACHMENTS_DIR (mặc định ./data/chung-tu).
 * Lịch gợi ý (cron máy chủ, 02:00 giờ VN):  0 19 * * *  cd /srv/ipre && npm run backup
 * Nên chép thư mục BACKUP_DIR sang nơi khác (ổ / dịch vụ lưu trữ khác máy chủ) — sao lưu cùng máy chủ không chống được mất máy.
 */
import { join } from "node:path";
import { createBackup, pruneBackups, restoreBackup, verifyBackup } from "../src/server/backup/service";

const env = (k: string, d?: string) => process.env[k] || d;
const need = (k: string) => {
  const v = env(k);
  if (!v) {
    console.error(`Thiếu ${k}.`);
    process.exit(1);
  }
  return v;
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const outDir = env("BACKUP_DIR", join(process.cwd(), "data", "sao-luu"))!;
const attachmentsDir = env("ATTACHMENTS_DIR", join(process.cwd(), "data", "chung-tu"))!;

async function main() {
  const args = process.argv.slice(2);
  const vao = args.indexOf("--vao");
  const positional = args.filter((a, i) => !a.startsWith("--") && !(vao >= 0 && i === vao + 1));
  const [cmd = "tao", file] = positional;
  const secret = need("BACKUP_KEY");
  if (cmd === "tao") {
    const r = await createBackup({ databaseUrl: need("DATABASE_URL"), attachmentsDir, outDir, secret });
    const total = Object.values(r.manifest.rows).reduce((a, b) => a + b, 0);
    console.log(`✓ ${r.path} (${mb(r.bytes)}): ${Object.keys(r.manifest.rows).length} bảng, ${total} dòng, ${r.manifest.attachments.count} tệp chứng từ`);
    const p = await pruneBackups(outDir);
    if (p.removed.length) console.log(`  Đã xoá ${p.removed.length} bản cũ; đang giữ ${p.kept.length} bản.`);
    return;
  }
  if (!file) throw new Error("Chỉ rõ tệp .ipbak");
  if (cmd === "kiem-tra") {
    const r = await verifyBackup(file, secret);
    console.log(`✓ Bản sao lưu lúc ${r.manifest.createdAt}: ${r.tables} bảng dữ liệu, ${r.manifest.attachments.count} tệp chứng từ, toàn vẹn.`);
    return;
  }
  if (cmd === "khoi-phuc") {
    const target = vao >= 0 ? args[vao + 1] : undefined;
    if (!target) throw new Error("Chỉ rõ CSDL đích: --vao postgres://…");
    if (!args.includes("--dong-y-ghi-de")) throw new Error("Khôi phục sẽ XOÁ và thay toàn bộ dữ liệu của CSDL đích — thêm --dong-y-ghi-de nếu chắc chắn");
    const r = await restoreBackup({ file, secret, targetUrl: target, attachmentsDir });
    console.log(`✓ Đã khôi phục bản lúc ${r.manifest.createdAt} vào ${new URL(target).pathname.slice(1)}; chép ${r.restoredFiles} tệp chứng từ.`);
    return;
  }
  throw new Error(`Lệnh không rõ: ${cmd} (tao | kiem-tra | khoi-phuc)`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
