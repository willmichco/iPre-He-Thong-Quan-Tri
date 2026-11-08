/**
 * Chạy iPre ngay trên máy của bạn (không cần VPS) và — tuỳ chọn — mở ra ngoài qua Cloudflare Tunnel
 * để dùng từ iPhone ở bất kỳ đâu, có HTTPS (camera quét mã chạy được).
 *
 *   npm run may                      # chỉ trên máy này: http://localhost:3000
 *   npm run may:cloudflare           # + đường dẫn https://… qua Cloudflare
 *   npm run may -- --build           # buộc build lại
 *
 * Bấm đúp: khoi-dong-ipre.bat (Windows) · khoi-dong-ipre.command (macOS) — chạy bản có Cloudflare.
 *
 * Các bước: đọc .env.local → kiểm tra cấu hình đăng nhập → bật PostgreSQL (Docker, nếu chưa chạy)
 * → migration → build khi mã đổi → sao lưu nếu đến hạn → next start (chỉ nghe 127.0.0.1)
 * → cloudflared → mở trình duyệt. Trong lúc chạy: sao lưu mỗi ngày, bot vận đơn 07:00 / 19:00 giờ VN.
 * Ctrl+C (hoặc đóng cửa sổ) là dừng hết.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres from "postgres";
import QRCode from "qrcode";

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const WIN = process.platform === "win32";
const PORT = Number(process.env.PORT ?? 3000);
const LOCAL = `http://localhost:${PORT}`;
const children: ChildProcess[] = [];

const say = (s: string) => console.log(`\x1b[36m▸\x1b[0m ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);
function fail(lines: string[]): never {
  console.error(`\n\x1b[31m✗\x1b[0m ${lines.join("\n  ")}\n`);
  process.exit(1);
}

/** Chạy lệnh tới khi xong; lỗi là dừng. */
function run(cmd: string, argv: string[], what: string) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", env: process.env, shell: WIN });
  if (r.status !== 0) fail([`${what} không thành công (mã ${r.status ?? r.error?.message}).`]);
}
const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore", shell: WIN }).status === 0;

// ── 1. Cấu hình ──────────────────────────────────────────────────────────────
const envFile = join(ROOT, ".env.local");
if (!existsSync(envFile)) {
  copyFileSync(join(ROOT, ".env.example"), envFile);
  warn("Đã tạo .env.local từ .env.example.");
}
// Đọc .env.local ĐÚNG cách Next đọc (kể cả quy tắc "\$"), để bộ khởi động và ứng dụng thấy cùng một giá trị.
loadEnvConfig(ROOT, false, { info: () => {}, error: (...m: unknown[]) => console.error(...m) });

const missing = ["OWNER_EMAIL", "OWNER_PASSWORD_HASH", "OWNER_TOTP_SECRET", "SESSION_SECRET"].filter((k) => !process.env[k]);
if (missing.length) {
  fail([
    "Chưa cấu hình tài khoản đăng nhập (bắt buộc khi chạy thật — nhất là khi mở ra ngoài qua Cloudflare).",
    "Chạy một lần:  npm run auth:setup -- --email ban@example.com",
    `rồi dán 4 dòng nó in ra vào ${envFile} và chạy lại. Thiếu: ${missing.join(", ")}`,
  ]);
}
const hash = process.env.OWNER_PASSWORD_HASH!;
if (!hash.startsWith("scrypt$") || hash.split("$").length !== 6) {
  fail([
    "OWNER_PASSWORD_HASH trong .env.local bị đọc sai — mỗi dấu $ phải viết thành \\$ (Next tự thay \"$…\").",
    "Ví dụ đúng:  OWNER_PASSWORD_HASH=scrypt\\$32768\\$8\\$1\\$…\\$…   (chạy lại npm run auth:setup để in sẵn dạng này).",
  ]);
}
if (!process.env.DATABASE_URL) fail(["Thiếu DATABASE_URL trong .env.local (xem .env.example)."]);

// ── 2. PostgreSQL ────────────────────────────────────────────────────────────
async function dbReady() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function ensureDb() {
  if (await dbReady()) return say("PostgreSQL đang chạy.");
  if (!has("docker")) {
    fail([
      "Không kết nối được PostgreSQL và máy chưa có Docker.",
      "Cài Docker Desktop (docker.com) rồi mở nó lên, hoặc cài PostgreSQL 16 và sửa DATABASE_URL trong .env.local.",
    ]);
  }
  say("Bật PostgreSQL bằng Docker…");
  run("docker", ["compose", "up", "-d", "--wait"], "Bật PostgreSQL (Docker Desktop đã mở chưa?)");
  for (let i = 0; i < 20; i++) {
    if (await dbReady()) return say("PostgreSQL sẵn sàng.");
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(["PostgreSQL đã bật nhưng không kết nối được — kiểm tra DATABASE_URL trong .env.local."]);
}

// ── 3. Build khi mã thay đổi ─────────────────────────────────────────────────
/** Dấu phiên bản mã: commit git (nếu có) + thời điểm sửa mới nhất của mã nguồn — đổi là build lại (kể cả tải ZIP đè lên). */
function sourceStamp() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: WIN }).stdout?.trim() || "khong-git";
  let newest = 0;
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else newest = Math.max(newest, st.mtimeMs);
  };
  for (const p of ["src", "db", "package-lock.json", "next.config.ts"]) walk(join(ROOT, p));
  return `${head}:${Math.floor(newest)}`;
}

function ensureBuild() {
  const stampFile = join(ROOT, ".next", "ipre-build-stamp");
  const stamp = sourceStamp();
  const built = existsSync(join(ROOT, ".next", "BUILD_ID")) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp;
  if (built && !args.has("--build")) return say("Bản build còn mới.");
  say("Build ứng dụng (lần đầu mất vài phút)…");
  run("npm", ["run", "build"], "Build");
  writeFileSync(stampFile, stamp);
}

// ── 4. Việc định kỳ ──────────────────────────────────────────────────────────
function backupDue() {
  if (!process.env.BACKUP_KEY) return false;
  const dir = process.env.BACKUP_DIR ?? join(ROOT, "data", "sao-luu");
  if (!existsSync(dir)) return true;
  const newest = Math.max(0, ...readdirSync(dir).filter((f) => f.endsWith(".ipbak")).map((f) => statSync(join(dir, f)).mtimeMs));
  return Date.now() - newest > 20 * 3600_000;
}
function backgroundJob(script: string, what: string) {
  const p = spawn("npm", ["run", script], { stdio: "inherit", env: process.env, shell: WIN });
  p.on("exit", (code) => (code === 0 ? say(`${what}: xong.`) : warn(`${what} lỗi (mã ${code}).`)));
}
function schedule() {
  const tracking = Boolean(process.env.UPS_CLIENT_ID || process.env.TRACK17_API_KEY);
  let lastSlot = "";
  setInterval(() => {
    if (backupDue()) backgroundJob("backup", "Sao lưu");
    // Giờ VN = UTC+7; bot vận đơn chạy 07:00 và 19:00.
    const vn = new Date(Date.now() + 7 * 3600_000);
    const slot = `${vn.toISOString().slice(0, 10)}-${vn.getUTCHours()}`;
    if (tracking && (vn.getUTCHours() === 7 || vn.getUTCHours() === 19) && slot !== lastSlot) {
      lastSlot = slot;
      backgroundJob("tracking", "Theo dõi vận đơn");
    }
  }, 10 * 60_000).unref();
  if (!process.env.BACKUP_KEY) warn("Chưa đặt BACKUP_KEY trong .env.local → KHÔNG tự sao lưu. Nên đặt (xem README › Sao lưu).");
}

// ── 5. Ứng dụng + Cloudflare ─────────────────────────────────────────────────
function startApp(): Promise<void> {
  const next = join(ROOT, "node_modules", "next", "dist", "bin", "next");
  // Chỉ nghe 127.0.0.1: người khác trong cùng Wi-Fi không vào thẳng được; đường ra ngoài duy nhất là Cloudflare.
  const env = { ...process.env, IPRE_LOCAL_HTTP: "1" }; // cho phép đăng nhập qua http://localhost trên Safari (xem session.ts)
  const p = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(PORT)], { stdio: ["ignore", "pipe", "inherit"], env });
  children.push(p);
  p.on("exit", (code) => {
    warn(`Ứng dụng đã dừng (mã ${code}).`);
    shutdown(code ?? 1);
  });
  return new Promise((resolve) => {
    p.stdout!.on("data", (b: Buffer) => {
      const s = b.toString();
      if (/ready|started server|Local:/i.test(s)) resolve();
      if (/error/i.test(s)) process.stdout.write(s);
    });
  });
}

function cloudflaredBin() {
  for (const c of ["cloudflared", ...(WIN ? ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"] : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"])]) {
    if (spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
  }
  return null;
}

async function showUrl(url: string, note: string) {
  console.log(`\n\x1b[32m✓ Mở từ iPhone / máy khác:\x1b[0m  \x1b[1m${url}\x1b[0m  ${note}\n`);
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
}

function startTunnel(): Promise<void> {
  const bin = cloudflaredBin();
  if (!bin) {
    warn("Chưa cài cloudflared → chỉ chạy trên máy này.");
    warn(WIN ? "Cài: winget install --id Cloudflare.cloudflared   (rồi mở lại cửa sổ)" : "Cài: brew install cloudflared");
    return Promise.resolve();
  }
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const argv = token
    ? ["tunnel", "--no-autoupdate", "run", "--token", token]
    : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`];
  say(token ? "Nối Cloudflare Tunnel (tên miền riêng)…" : "Mở đường hầm Cloudflare tạm (trycloudflare.com)…");
  const p = spawn(bin, argv, { stdio: ["ignore", "ignore", "pipe"] });
  children.push(p);
  p.on("exit", (code) => warn(`Cloudflare Tunnel đã dừng (mã ${code}) — ứng dụng vẫn chạy trên máy này.`));
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    setTimeout(finish, 30_000);
    p.stderr!.on("data", async (b: Buffer) => {
      const s = b.toString();
      if (done) return;
      const quick = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (quick) {
        await showUrl(quick[0], "(đổi mỗi lần khởi động — muốn cố định xem docs/08-chay-tai-may-cloudflare.md)");
        finish();
      } else if (token && /Registered tunnel connection/i.test(s)) {
        const pub = process.env.IPRE_PUBLIC_URL;
        if (pub) await showUrl(pub, "");
        else say("Đã nối Cloudflare. Mở bằng tên miền bạn gán cho tunnel (đặt IPRE_PUBLIC_URL để in mã QR).");
        finish();
      }
    });
  });
}

function openBrowser(url: string) {
  if (args.has("--khong-mo")) return;
  const [cmd, argv] = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, argv as string[], { stdio: "ignore", detached: true }).unref();
}

function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  await ensureDb();
  say("Cập nhật cấu trúc CSDL…");
  run("npm", ["run", "db:migrate"], "Migration");
  ensureBuild();
  if (backupDue()) {
    say("Sao lưu trước khi chạy…");
    run("npm", ["run", "backup"], "Sao lưu");
  }
  say("Khởi động iPre…");
  await startApp();
  console.log(`\n\x1b[32m✓ iPre trên máy này:\x1b[0m  \x1b[1m${LOCAL}\x1b[0m`);
  if (args.has("--cloudflare") || process.env.CLOUDFLARE_TUNNEL_TOKEN) await startTunnel();
  schedule();
  openBrowser(LOCAL);
  console.log("Để cửa sổ này mở trong lúc dùng. Ctrl+C hoặc đóng cửa sổ để dừng.\n");
}

main().catch((e) => fail([String(e?.message ?? e)]));
