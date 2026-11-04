// Chép các bộ giải mã chạy trên trình duyệt vào public/ để ứng dụng tự phục vụ, không phụ thuộc CDN:
//  - public/wasm/zxing_reader.wasm   (giải mã mã vạch)
//  - public/ocr/*                     (đọc chữ Tesseract: worker, lõi LSTM, dữ liệu tiếng Anh)
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const out = (...p) => join(process.cwd(), "public", ...p);

function copy(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

copy(require.resolve("zxing-wasm/reader/zxing_reader.wasm"), out("wasm", "zxing_reader.wasm"));

const tessDist = dirname(require.resolve("tesseract.js/dist/worker.min.js"));
const coreDir = dirname(require.resolve("tesseract.js-core/package.json"));
const engDir = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
copy(join(tessDist, "worker.min.js"), out("ocr", "worker.min.js"));
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
  copy(join(coreDir, f), out("ocr", f));
}
// Hai bộ dữ liệu tiếng Anh:
//  - ocr/eng.traineddata.gz       bản "best_int" (@tesseract.js-data/eng) — ảnh tải lên/dán vào: ưu tiên đọc đúng
//  - ocr/fast/eng.traineddata.gz  bản "fast" (tesseract-ocr/tessdata_fast, Apache-2.0, lưu ở assets/ocr/) — camera:
//    đọc màn hình nhanh hơn ~1,5–2 lần; đã đo: bản này đọc sót IMEI trên một số ảnh chụp màn hình nền sáng,
//    nên không dùng cho ảnh tải lên.
copy(join(engDir, "4.0.0_best_int", "eng.traineddata.gz"), out("ocr", "eng.traineddata.gz"));
copy(join(process.cwd(), "assets", "ocr", "eng-fast.traineddata.gz"), out("ocr", "fast", "eng.traineddata.gz"));

console.log("✓ public/wasm/zxing_reader.wasm · public/ocr/ (Tesseract)");
