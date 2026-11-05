/**
 * Sao lưu & khôi phục.
 *
 * Một bản sao lưu (.ipbak) = MÃ HOÁ AES-256-GCM của một gói ZIP gồm:
 *   - manifest.json  (thời điểm, phiên bản migration, số dòng từng bảng, mã băm từng phần)
 *   - csdl.dump      (pg_dump --format=custom: khôi phục được bằng pg_restore)
 *   - chung-tu/...   (toàn bộ tệp chứng từ trong ATTACHMENTS_DIR)
 * Định dạng tệp: "IPREBAK1" | salt (16) | iv (12) | tag (16) | dữ liệu mã hoá. Khoá = scrypt(BACKUP_KEY, salt).
 * Sai khoá hoặc tệp bị sửa dù 1 byte → giải mã báo lỗi (GCM xác thực), không bao giờ khôi phục dữ liệu hỏng.
 */
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import postgres from "postgres";
import { backupName, retention } from "@/domain/backup";
import { unzip, zip } from "@/server/zip";

const MAGIC = Buffer.from("IPREBAK1");

// ---- Mã hoá ---------------------------------------------------------------------------------------------

function keyFrom(secret: string, salt: Buffer) {
  if (secret.length < 16) throw new Error("BACKUP_KEY quá ngắn — cần ít nhất 16 ký tự (nên dùng chuỗi ngẫu nhiên 32+ ký tự)");
  return scryptSync(secret, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encrypt(plain: Buffer, secret: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret, salt), iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decrypt(file: Buffer, secret: string): Buffer {
  if (file.length < 52 || !file.subarray(0, 8).equals(MAGIC)) throw new Error("Không phải tệp sao lưu iPre (.ipbak)");
  const salt = file.subarray(8, 24);
  const iv = file.subarray(24, 36);
  const tag = file.subarray(36, 52);
  const d = createDecipheriv("aes-256-gcm", keyFrom(secret, salt), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(file.subarray(52)), d.final()]);
  } catch {
    throw new Error("Giải mã thất bại: sai BACKUP_KEY hoặc tệp sao lưu đã bị hỏng / bị sửa");
  }
}

// ---- pg_dump / pg_restore -------------------------------------------------------------------------------

/** Biến môi trường kết nối cho công cụ dòng lệnh PostgreSQL — mật khẩu đi qua PGPASSWORD, không hiện trên dòng lệnh. */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? "prefer",
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.on("error", (e) => reject(new Error(`Không chạy được ${cmd}: ${e.message} — cài postgresql-client cùng phiên bản máy chủ`)));
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} lỗi (mã ${code}): ${Buffer.concat(err).toString().trim().slice(0, 2000)}`)),
    );
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

// ---- Tệp chứng từ ---------------------------------------------------------------------------------------

async function listFiles(root: string): Promise<string[]> {
  try {
    await stat(root);
  } catch {
    return [];
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.endsWith(".tmp"))
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface Manifest {
  format: 1;
  createdAt: string;
  migrations: string[];
  rows: Record<string, number>;
  database: { file: "csdl.dump"; bytes: number; sha256: string };
  attachments: { count: number; bytes: number };
}

// ---- Tạo / kiểm tra / khôi phục -------------------------------------------------------------------------

export async function createBackup(opts: { databaseUrl: string; attachmentsDir: string; outDir: string; secret: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const dump = await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--compress=6"], pgEnv(opts.databaseUrl));
  const sql = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });
  let migrations: string[];
  const rows: Record<string, number> = {};
  try {
    migrations = (await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((r) => r.name);
    const tables = await sql<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`;
    for (const { t } of tables) rows[t] = Number((await sql.unsafe(`SELECT COUNT(*)::bigint AS n FROM "${t.replace(/"/g, '""')}"`))[0].n);
  } finally {
    await sql.end();
  }
  const files = await listFiles(opts.attachmentsDir);
  const docs = await Promise.all(files.map(async (f) => ({ name: `chung-tu/${f}`, data: await readFile(join(opts.attachmentsDir, f)) })));
  const manifest: Manifest = {
    format: 1,
    createdAt: now.toISOString(),
    migrations,
    rows,
    database: { file: "csdl.dump", bytes: dump.length, sha256: sha(dump) },
    attachments: { count: docs.length, bytes: docs.reduce((s, d) => s + d.data.length, 0) },
  };
  // dump đã nén, ảnh / PDF đã nén → ZIP chỉ đóng gói (store)
  const bundle = zip([{ name: "manifest.json", data: JSON.stringify(manifest, null, 2) }, { name: "csdl.dump", data: dump }, ...docs], { store: true });
  const enc = encrypt(bundle, opts.secret);
  await mkdir(opts.outDir, { recursive: true });
  const path = join(opts.outDir, backupName(now));
  await writeFile(`${path}.tmp`, enc);
  await rename(`${path}.tmp`, path); // ghi tạm rồi đổi tên → không bao giờ có bản sao lưu ghi dở
  return { path, bytes: enc.length, manifest };
}

/** Giải mã + kiểm tra toàn vẹn (mã băm bản CSDL, pg_restore --list đọc được). Không ghi gì. */
export async function verifyBackup(file: string, secret: string) {
  const parts = unzip(decrypt(await readFile(file), secret));
  const manifest = JSON.parse(parts.get("manifest.json")?.toString() ?? "null") as Manifest | null;
  if (!manifest || manifest.format !== 1) throw new Error("Bản sao lưu thiếu manifest.json");
  const dump = parts.get("csdl.dump");
  if (!dump || sha(dump) !== manifest.database.sha256) throw new Error("Bản CSDL trong gói sao lưu sai mã băm");
  const docs = [...parts.keys()].filter((k) => k.startsWith("chung-tu/"));
  if (docs.length !== manifest.attachments.count) throw new Error(`Thiếu tệp chứng từ: có ${docs.length}, manifest ghi ${manifest.attachments.count}`);
  const dir = await mkdtemp(join(tmpdir(), "ipre-kiem-tra-"));
  try {
    await writeFile(join(dir, "csdl.dump"), dump);
    const list = (await run("pg_restore", ["--list", join(dir, "csdl.dump")], process.env)).toString();
    const tables = (list.match(/ TABLE DATA public /g) ?? []).length;
    return { manifest, tables, parts };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Khôi phục vào CSDL đích (xoá & tạo lại mọi đối tượng trong một transaction — lỗi giữa chừng thì CSDL đích giữ nguyên)
 * và chép tệp chứng từ vào attachmentsDir (không ghi đè tệp đã có — tên theo mã băm nên trùng tên là trùng nội dung).
 */
export async function restoreBackup(opts: { file: string; secret: string; targetUrl: string; attachmentsDir: string }) {
  const { manifest, parts } = await verifyBackup(opts.file, opts.secret);
  const dir = await mkdtemp(join(tmpdir(), "ipre-khoi-phuc-"));
  try {
    await writeFile(join(dir, "csdl.dump"), parts.get("csdl.dump")!);
    await run(
      "pg_restore",
      [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--exit-on-error",
        "--dbname",
        new URL(opts.targetUrl).pathname.slice(1),
        join(dir, "csdl.dump"),
      ],
      pgEnv(opts.targetUrl),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  let restored = 0;
  for (const [name, data] of parts) {
    if (!name.startsWith("chung-tu/")) continue;
    const target = join(opts.attachmentsDir, name.slice("chung-tu/".length));
    if (!target.startsWith(join(opts.attachmentsDir, sep)) && target !== opts.attachmentsDir) throw new Error(`Đường dẫn chứng từ không an toàn: ${name}`);
    try {
      await stat(target);
      continue;
    } catch {
      /* chưa có → chép */
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    restored++;
  }
  return { manifest, restoredFiles: restored };
}

/** Xoá bản cũ theo chính sách giữ 30 ngày + 12 tháng. Trả về các tệp đã xoá. */
export async function pruneBackups(outDir: string, opts?: { days?: number; months?: number }) {
  const names = (await readdir(outDir)).filter((n) => n.endsWith(".ipbak"));
  const { remove, keep } = retention(names, opts);
  for (const n of remove) await rm(join(outDir, n));
  return { removed: remove, kept: keep };
}
