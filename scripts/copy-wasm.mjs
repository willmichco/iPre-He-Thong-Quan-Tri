// Chép bộ giải mã mã vạch (WebAssembly) vào public/ để ứng dụng tự phục vụ, không phụ thuộc CDN.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const src = require.resolve("zxing-wasm/reader/zxing_reader.wasm");
const dest = join(process.cwd(), "public", "wasm", "zxing_reader.wasm");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("✓ public/wasm/zxing_reader.wasm");
