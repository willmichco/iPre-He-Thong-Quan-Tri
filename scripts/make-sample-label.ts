/**
 * Tạo "nhãn hộp mẫu" (giả lập bố cục nhãn sau hộp máy Apple) để thử bộ quét
 * khi chưa có hộp thật: mở file trên máy tính rồi quét bằng điện thoại.
 * Mọi mã đều là số liệu minh hoạ, không thuộc thiết bị thật nào.
 *
 *   npm run sample:label   → public/nhan-mau.svg
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/full";

const require = createRequire(import.meta.url);

export const SAMPLE_DEVICES = [
  {
    title: "iPhone Pro Max 256GB Silver",
    part: "MDEM1LL/A",
    serial: "F2LXQ7Y9KD",
    imei1: "350000000000006",
    imei2: "350000000000014",
    upc: "012345678905",
  },
  {
    title: "iPad Air 11 Wi-Fi + Cellular 128GB Blue",
    part: "MDEM2VN/A",
    serial: "C02XL0GTJGH5",
    imei1: "490154203237518",
    imei2: null,
    upc: null,
  },
] as const;

async function barcodeImage(text: string, format: "Code128" | "UPCA") {
  const out = await writeBarcode(text, { format, scale: 2, addQuietZones: true });
  const buf = Buffer.from(await out.image!.arrayBuffer());
  const { width, height } = out.symbol!;
  return { href: `data:image/png;base64,${buf.toString("base64")}`, width, height };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

async function label(device: (typeof SAMPLE_DEVICES)[number], offsetY: number) {
  const rows: [string, string, "Code128" | "UPCA"][] = [
    ["(1P) Part No.", "1P" + device.part, "Code128"],
    ["(S) Serial No.", "S" + device.serial, "Code128"],
    ["IMEI", device.imei1, "Code128"],
  ];
  if (device.imei2) rows.push(["IMEI2", device.imei2, "Code128"]);
  if (device.upc) rows.push(["UPC", device.upc, "UPCA"]);

  const parts: string[] = [];
  let y = offsetY + 64;
  for (const [caption, value, format] of rows) {
    const img = await barcodeImage(value, format);
    const w = Math.min(420, img.width * 2);
    const h = 54;
    const shown = value.startsWith("1P") || (caption.startsWith("(S)") && value.startsWith("S")) ? value.slice(caption.startsWith("(S)") ? 1 : 2) : value;
    parts.push(
      `<text x="32" y="${y + 16}" font-size="14" font-family="Helvetica, Arial" fill="#111">${esc(caption)}: ${esc(shown)}</text>`,
      `<image x="32" y="${y + 24}" width="${w}" height="${h}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${img.href}"/>`,
    );
    y += 94;
  }
  const height = y - offsetY + 8;
  return {
    height,
    svg: [
      `<rect x="16" y="${offsetY}" width="568" height="${height}" rx="10" fill="#fff" stroke="#bbb"/>`,
      `<text x="32" y="${offsetY + 34}" font-size="17" font-weight="700" font-family="Helvetica, Arial" fill="#111">${esc(device.title)}</text>`,
      `<text x="568" y="${offsetY + 34}" text-anchor="end" font-size="11" font-family="Helvetica, Arial" fill="#b42318">NHÃN MẪU — số liệu minh hoạ</text>`,
      ...parts,
    ].join("\n"),
  };
}

async function main() {
  const wasm = readFileSync(require.resolve("zxing-wasm/full/zxing_full.wasm"));
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
    fireImmediately: true,
  });
  let y = 16;
  const blocks: string[] = [];
  for (const d of SAMPLE_DEVICES) {
    const l = await label(d, y);
    blocks.push(l.svg);
    y += l.height + 16;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${y}" viewBox="0 0 600 ${y}">\n<rect width="100%" height="100%" fill="#f2f2f2"/>\n${blocks.join("\n")}\n</svg>\n`;
  const out = join(process.cwd(), "public", "nhan-mau.svg");
  writeFileSync(out, svg);
  console.log("✓ public/nhan-mau.svg");
}

main();
