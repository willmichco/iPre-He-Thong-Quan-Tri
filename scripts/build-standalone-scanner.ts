/**
 * Đóng gói bộ quét mã thành MỘT file HTML để dùng thử trên điện thoại mà không cần cài ứng dụng.
 * - Mã nguồn: đúng component dùng trong ứng dụng (src/features/scanner).
 * - React 18 tải từ cdnjs; bộ giải mã zxing (WebAssembly) và nhãn mẫu nhúng dạng base64.
 *
 *   npm run build:standalone   → dist/quet-ma-thu.html
 */
import { build, type Plugin } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const REACT_VERSION = "18.3.1";

/** Thay react/react-dom bằng biến toàn cục từ bản UMD trên CDN. */
const reactGlobals: Plugin = {
  name: "react-globals",
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/client|\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (args) => ({
      path: args.path,
      namespace: "react-global",
    }));
    b.onLoad({ filter: /.*/, namespace: "react-global" }, (args) => {
      if (args.path === "react") return { contents: "module.exports = window.React;", loader: "js" };
      if (args.path.startsWith("react-dom")) return { contents: "module.exports = window.ReactDOM;", loader: "js" };
      // JSX runtime tự động → createElement của React 18
      return {
        loader: "js",
        contents: `
          const R = window.React;
          function jsx(type, props, key) { return R.createElement(type, key === undefined ? props : Object.assign({}, props, { key })); }
          module.exports = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: R.Fragment };`,
      };
    });
  },
};

async function main() {
  const result = await build({
    entryPoints: [join(root, "src/features/scanner/standalone.tsx")],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    target: ["es2020", "safari15"],
    jsx: "automatic",
    outdir: "out",
    plugins: [reactGlobals],
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "warning",
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const wasmB64 = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")).toString("base64");
  const labelB64 = readFileSync(join(root, "public", "nhan-mau.svg")).toString("base64");

  const html = `<title>Quét mã iPre</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Bố cục: một cột công cụ, thẻ từng máy xếp dọc; màu theo bộ quét của ứng dụng iPre */
:root {
  --page-bg: #f6f7f9;
  --page-fg: #14181f;
  --page-muted: #5b6472;
  --page-border: #dde1e7;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --page-bg: #0f1217; --page-fg: #e8ebf0; --page-muted: #9aa3b2; --page-border: #2a303b; color-scheme: dark; }
}
:root[data-theme="dark"] { --page-bg: #0f1217; --page-fg: #e8ebf0; --page-muted: #9aa3b2; --page-border: #2a303b; color-scheme: dark; }
body {
  background: var(--page-bg);
  color: var(--page-fg);
  padding-left: max(0px, env(safe-area-inset-left, 0px));
  padding-right: max(0px, env(safe-area-inset-right, 0px));
}
.demo-note {
  max-width: 880px;
  margin: 0 auto;
  padding-block: 12px 0;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  color: var(--page-muted);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}
.demo-note strong { color: var(--page-fg); }
.sc-root { padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.sc-actions { padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
.sc-toast { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
${css}
</style>
<p class="demo-note"><strong>Bản chạy thử GĐ0.</strong> Mọi xử lý diễn ra ngay trên máy của bạn; ảnh và mã không được gửi đi đâu. Kết quả chỉ lưu tạm trên trình duyệt này — dùng <strong>Tải CSV</strong> hoặc <strong>Sao chép bảng</strong> để giữ lại.</p>
<div id="ipre-scanner"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/${REACT_VERSION}/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/${REACT_VERSION}/umd/react-dom.production.min.js"></script>
<script>window.__IPRE_WASM_B64__="${wasmB64}";window.__IPRE_SAMPLE_LABEL__="data:image/svg+xml;base64,${labelB64}";</script>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
`;
  mkdirSync(join(root, "dist"), { recursive: true });
  const out = join(root, "dist", "quet-ma-thu.html");
  writeFileSync(out, html);
  console.log(`✓ dist/quet-ma-thu.html (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
