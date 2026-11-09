/**
 * Chụp BẢN XEM THỬ TĨNH của toàn bộ ứng dụng cho GitHub Pages (nhánh gh-pages) — kèm khung chat Trợ lý chạy được
 * ngay trên trình duyệt (dữ liệu mẫu, không lưu gì).
 *
 *   DATABASE_URL=… npm run db:seed && npm run demo:data     # CSDL dữ liệu mẫu (KHÔNG dùng CSDL thật)
 *   npm run build && npm run build:standalone              # bản production + bộ quét độc lập
 *   npm run build:site                                      # → dist/site/
 *
 * Cách làm: chạy `next start` với một tài khoản chủ tạm, ký sẵn cookie phiên, đi lần mọi link nội bộ từ "/", lưu HTML đã render:
 * bỏ toàn bộ script của Next, gộp CSS, đổi link "/kho/123" → "kho__123.html" (truy vấn → "--khoa-giatri"), form chỉ báo
 * "bản xem thử". Trang Quét mã = bộ quét độc lập (chạy thật). Trang Trợ lý = chat demo (src/features/assistant-demo)
 * + câu trả lời dựng sẵn bằng chính answerQuery (khớp số liệu các trang).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import postgres from "postgres";
import type { DemoPack } from "@/domain/assistant/demo";
import type { Reply } from "@/domain/assistant/reply";
import { todayVn } from "@/server/assistant/context";
import { buildDemoPack } from "@/server/assistant/demo-pack";
import { SESSION_COOKIE, signSessionToken } from "@/server/auth/session-token";

const root = process.cwd();
const OUT = join(root, "dist", "site");
const PORT = Number(process.env.SITE_PORT ?? 3210);
const BASE = `http://localhost:${PORT}`;
const OWNER = { email: "ban-xem-thu@ipre.local", secret: "ban-xem-thu-tinh-khong-dung-cho-moi-truong-that-0123456789" };
const DEMO_NOTE = "Đây là bản xem thử tĩnh: không lưu được dữ liệu. Dùng bản chạy thật để thao tác.";
const BANNER =
  `<div data-demo-banner="" class="mx-3 mt-3 rounded-2xl bg-[var(--warn-bg)] px-4 py-2 text-sm text-[var(--warn)] md:mx-8">` +
  `Bản xem thử tĩnh (GitHub Pages) — dữ liệu mẫu, không có máy chủ: xem được mọi màn hình, nút lưu / bán chỉ báo thông báo. ` +
  `Riêng “Quét mã” chạy thật ngay trên máy, và <a class="font-semibold underline" href="tro-ly.html">Trợ lý</a> nhắn thử được (không lưu).</div>`;
/** mở / đóng bảng "Thêm" trên điện thoại (thay cho React đã bỏ) */
const MORE_SHEET_JS = `<script>(function(){var b=document.querySelector('[aria-controls="more-sheet"]'),s=document.getElementById('more-sheet'),k=document.querySelector('.sheet-backdrop');if(!b||!s)return;function set(o){if(o){s.setAttribute('data-open','');k&&k.setAttribute('data-open','');s.removeAttribute('inert')}else{s.removeAttribute('data-open');k&&k.removeAttribute('data-open');s.setAttribute('inert','')}b.setAttribute('aria-expanded',o?'true':'false')}b.addEventListener('click',function(){set(!s.hasAttribute('data-open'))});k&&k.addEventListener('click',function(){set(false)});document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)})})();</script>`;

/** route không chụp (tải file, API, đăng nhập) */
const SKIP = [/^\/_next\//, /^\/api\//, /^\/dang-nhap/, /^\/chung-tu\//, /\/xuat(\?|$)/, /^\/cai-dat\/xuat-du-lieu/, /^\/(icons|ocr|wasm)\//, /\.[a-z0-9]{2,5}(\?|$)/i];
const isPage = (p: string) => p.startsWith("/") && !p.startsWith("//") && !SKIP.some((re) => re.test(p));

/** "/kho/123?chang=hn#x" → "kho__123--chang-hn.html#x" (cùng quy ước bản chụp trước) */
export function fileOf(href: string): string {
  const [noHash, hash] = href.split("#");
  const [path, query] = noHash.split("?");
  const base = path === "/" || path === "" ? "index" : path.replace(/^\/+|\/+$/g, "").replace(/\//g, "__");
  const params = query ? [...new URLSearchParams(query)].flatMap(([k, v]) => [k, v]) : [];
  const q = params.length ? `--${params.join("-")}` : "";
  return `${`${base}${q}`.replace(/[^A-Za-z0-9._-]+/g, "-")}.html${hash ? `#${hash}` : ""}`;
}
const pageKey = (href: string) => href.split("#")[0];
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

async function waitFor(url: string, ms = 60_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* chưa lên */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Máy chủ không lên: ${url}`);
}

/** Đổi mọi link nội bộ trong câu trả lời của gói demo sang tên tệp tĩnh; trả các trang cần chụp thêm. */
function rewritePackLinks(pack: DemoPack, map: (href: string) => string) {
  const fix = (r: Reply) => {
    if (r.link) r.link.href = map(r.link.href);
    for (const c of r.cards ?? []) if (c.kind === "table" && c.hrefs) c.hrefs = c.hrefs.map((h) => (h ? map(h) : h));
  };
  Object.values(pack.answers).forEach(fix);
  pack.batches.forEach((b) => (b.href = map(b.href)));
  pack.shipments.forEach((s) => (s.href = map(s.href)));
}

async function main() {
  if (!existsSync(join(root, ".next", "BUILD_ID"))) throw new Error("Chạy `npm run build` trước");
  if (!existsSync(join(root, "dist", "pages", "index.html"))) throw new Error("Chạy `npm run build:standalone` trước (trang Quét mã)");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Cần DATABASE_URL (CSDL dữ liệu mẫu)");

  // 1. gói dữ liệu chat demo (đọc thẳng CSDL)
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  const today = todayVn();
  const pack = await buildDemoPack(sql, today).finally(() => sql.end());
  console.log(`✓ Gói chat demo: ${Object.keys(pack.answers).length} câu trả lời dựng sẵn, ${pack.items.length} máy`);

  // 2. máy chủ production với tài khoản chủ tạm
  const server: ChildProcess = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      OWNER_EMAIL: OWNER.email,
      OWNER_PASSWORD_HASH: "scrypt$32768$8$1$c2FsdA==$aGFzaA==",
      OWNER_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      SESSION_SECRET: OWNER.secret,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  try {
    await waitFor(`${BASE}/api/health`);
    const cookie = `${SESSION_COOKIE}=${await signSessionToken(OWNER.email, OWNER.secret)}`;
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(join(OUT, "assets", "media"), { recursive: true });

    // 3. đi lần các trang
    const queue: string[] = ["/", "/tro-ly", "/tro-ly/bang-ke"];
    for (const r of Object.values(pack.answers)) {
      if (r.link) queue.push(r.link.href);
      for (const c of r.cards ?? []) if (c.kind === "table") for (const h of c.hrefs ?? []) if (h) queue.push(h);
    }
    const seen = new Set<string>();
    const pages = new Map<string, string>(); // key → html
    const css = new Set<string>();
    // lấy HTML từ trình duyệt: nội dung gửi kiểu streaming (loading.tsx / Suspense) chỉ được hoán vào chỗ khi chạy JS
    const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
    const bctx = await browser.newContext({ locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
    await bctx.addCookies([{ name: SESSION_COOKIE, value: cookie.split("=").slice(1).join("="), url: BASE }]);
    const tab = await bctx.newPage();
    while (queue.length) {
      const href = decode(queue.shift()!);
      const key = pageKey(href);
      if (seen.has(key) || !isPage(key)) continue;
      seen.add(key);
      if (key === "/quet-ma") continue; // thay bằng bộ quét độc lập
      const res = await tab.goto(BASE + key, { waitUntil: "networkidle" });
      if (!res || res.status() !== 200 || new URL(tab.url()).pathname !== key.split("?")[0]) {
        console.warn(`  bỏ ${key} (HTTP ${res?.status()})`);
        continue;
      }
      // chờ mọi khối streaming đã hoán vào (không còn <div hidden id="S:…">)
      await tab.waitForFunction(() => !document.querySelector('div[hidden][id^="S:"]'), null, { timeout: 15_000 }).catch(() => {});
      const html = `<!DOCTYPE html>${await tab.evaluate(() => document.documentElement.outerHTML)}`;
      pages.set(key, html);
      for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) css.add(m[1]);
      for (const m of html.matchAll(/\shref="(\/[^"]*)"/g)) {
        const k = pageKey(decode(m[1]));
        if (isPage(k) && !seen.has(k)) queue.push(k);
      }
      if (pages.size % 100 === 0) console.log(`  … ${pages.size} trang`);
    }
    await browser.close();
    const known = new Set([...pages.keys(), "/quet-ma"]);
    const map = (href: string) => {
      const h = decode(href);
      if (/^\/(bao-cao|tro-ly)\/xuat|^\/cai-dat\/xuat-du-lieu|^\/chung-tu\//.test(h)) return "#ban-xem-thu";
      return h.startsWith("/") && known.has(pageKey(h)) ? fileOf(h) : h.startsWith("/") ? "#ban-xem-thu" : h;
    };

    // 4. CSS + phông
    let cssText = "";
    for (const c of css) {
      let t = await (await fetch(BASE + c)).text();
      for (const m of new Set([...t.matchAll(/url\((\/_next\/static\/media\/[^)]+)\)/g)].map((x) => x[1]))) {
        const name = basename(m);
        writeFileSync(join(OUT, "assets", "media", name), Buffer.from(await (await fetch(BASE + m)).arrayBuffer()));
        t = t.split(m).join(`media/${name}`);
      }
      cssText += `${t}\n`;
    }
    writeFileSync(join(OUT, "assets", "app-0.css"), cssText);

    // 5. chat demo
    rewritePackLinks(pack, map);
    const demo = await build({
      entryPoints: [join(root, "src/features/assistant-demo/main.ts")],
      bundle: true,
      write: false,
      minify: true,
      format: "iife",
      target: ["es2020", "safari15"],
      tsconfig: join(root, "tsconfig.json"),
      logLevel: "warning",
    });
    const demoJs = demo.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
    const packJson = JSON.stringify(pack).replace(/</g, "\\u003c");

    // 6. ghi từng trang
    const alertJs = `alert(${JSON.stringify(DEMO_NOTE).replace(/"/g, "&quot;")});return false`;
    for (const [key, raw] of pages) {
      let html = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<link[^>]+rel="(preload|modulepreload|expect)"[^>]*>/gi, "")
        .replace(/<link[^>]+rel="stylesheet"[^>]*>/gi, "")
        .replace(/<next-route-announcer[\s\S]*?<\/next-route-announcer>/gi, "")
        .replace(/<nextjs-portal[\s\S]*?<\/nextjs-portal>/gi, "");
      html = html.replace("</head>", `<link rel="stylesheet" href="assets/app-0.css"></head>`);
      // link nội bộ
      html = html.replace(/(\shref=")(\/[^"]*)"/g, (_m, pre: string, h: string) => {
        if (/^\/(icons|favicon|manifest)/.test(h)) return `${pre}${h.replace(/^\//, "").replace(/\?.*$/, "")}"`;
        const to = map(h);
        return to === "#ban-xem-thu" ? `${pre}#" onclick="${alertJs}"` : `${pre}${to}"`;
      });
      html = html.replace(/(\ssrc=")\/(nhan-mau\.svg|icons\/[^"]+)"/g, "$1$2\"");
      // form: chỉ báo (trừ khung chat của Trợ lý — chat demo tự xử lý)
      html = html.replace(/<form(?![^>]*data-testid="chat-form")([^>]*)>/g, (_m, attrs: string) => `<form${attrs.replace(/\saction="[^"]*"/, "")} onsubmit="${alertJs}">`);
      html = html.replace(/<main\b/, `${BANNER}<main`);
      let tail = MORE_SHEET_JS;
      if (key === "/tro-ly") tail += `<script>window.__IPRE_DEMO__=${packJson};</script><script>${demoJs}</script>`;
      html = html.replace("</body>", `${tail}</body>`);
      writeFileSync(join(OUT, fileOf(key)), html);
    }

    // 7. trang Quét mã = bộ quét độc lập; tài nguyên tĩnh
    writeFileSync(join(OUT, "quet-ma.html"), readFileSync(join(root, "dist", "pages", "index.html")));
    cpSync(join(root, "dist", "pages", "ocr"), join(OUT, "ocr"), { recursive: true });
    cpSync(join(root, "public", "nhan-mau.svg"), join(OUT, "nhan-mau.svg"));
    if (existsSync(join(root, "public", "icons"))) cpSync(join(root, "public", "icons"), join(OUT, "icons"), { recursive: true });
    if (existsSync(join(root, "src", "app", "favicon.ico"))) cpSync(join(root, "src", "app", "favicon.ico"), join(OUT, "favicon.ico"));
    writeFileSync(join(OUT, ".nojekyll"), "");

    // 8. kiểm tra link hỏng
    const files = new Set(readdirSync(OUT));
    let broken = 0;
    for (const f of files) {
      if (!f.endsWith(".html")) continue;
      for (const m of readFileSync(join(OUT, f), "utf8").matchAll(/\shref="([^"#:]+\.html)(#[^"]*)?"/g))
        if (!files.has(m[1])) {
          broken++;
          if (broken <= 10) console.warn(`  link hỏng: ${f} → ${m[1]}`);
        }
    }
    console.log(`✓ dist/site/: ${pages.size + 1} trang${broken ? ` — ${broken} link hỏng` : ", không có link hỏng"}`);
    if (broken) process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
