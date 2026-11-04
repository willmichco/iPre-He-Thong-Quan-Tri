/**
 * Điểm vào của bản quét mã chạy thử độc lập (một file HTML, xem scripts/build-standalone-scanner.ts).
 * Bộ giải mã WebAssembly và nhãn mẫu được nhúng sẵn trong trang.
 */
import { createRoot } from "react-dom/client";
import { Scanner } from "./Scanner";

declare global {
  interface Window {
    __IPRE_WASM_B64__?: string;
    __IPRE_SAMPLE_LABEL__?: string;
    claude?: { use(name: string): Promise<unknown> };
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

type Downloads = { save(req: { filename: string; data: string }): Promise<unknown> };

/** Trong khung xem thử của claude.ai, tải file phải đi qua khả năng "downloads"; ngoài đó thì tải bình thường. */
async function saveFile(filename: string, content: string) {
  const downloads = window.claude ? ((await window.claude.use("downloads")) as Downloads | null) : null;
  if (downloads) {
    await downloads.save({ filename, data: content });
    return;
  }
  if (window.claude) throw new Error("unavailable");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const wasm = { binary: base64ToArrayBuffer(window.__IPRE_WASM_B64__ ?? "") };
// Trong khung xem thử, camera trực tiếp bị chặn; mở file HTML trực tiếp (https) thì dùng được.
const liveCamera = !window.claude;

createRoot(document.getElementById("ipre-scanner")!).render(
  <Scanner
    wasm={wasm}
    storageKey="ipre.scan-demo"
    liveCamera={liveCamera}
    saveFile={saveFile}
    sampleLabelUrl={window.__IPRE_SAMPLE_LABEL__}
  />,
);
