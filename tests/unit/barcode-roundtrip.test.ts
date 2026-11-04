/**
 * Tạo mã vạch thật (Code 128, UPC-A) bằng zxing-wasm rồi giải mã lại bằng
 * chính bộ giải mã dùng trong ứng dụng — đảm bảo chuỗi đọc được đi qua
 * bộ phân loại đúng như nhãn hộp máy.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareZXingModule, readBarcodes, writeBarcode } from "zxing-wasm/full";
import { classifyCode } from "@/domain/identifiers";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("zxing-wasm/full/zxing_full.wasm"));
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
    fireImmediately: true,
  });
});

async function roundTrip(text: string, format: "Code128" | "UPCA") {
  const out = await writeBarcode(text, { format, scale: 3 });
  const png = new Uint8Array(await out.image!.arrayBuffer());
  const results = await readBarcodes(png, { formats: ["Code128", "UPCA"], tryHarder: true });
  return results.map((r) => r.text);
}

describe("mã vạch → giải mã → phân loại", () => {
  it.each([
    ["SF2LXQ7Y9KD", "Code128", "SERIAL", "F2LXQ7Y9KD"],
    ["350000000000006", "Code128", "IMEI", "350000000000006"],
    ["1PMDEM1LL/A", "Code128", "PART_NUMBER", "MDEM1LL/A"],
    ["012345678905", "UPCA", "UPC", "012345678905"],
  ] as const)("%s (%s)", async (text, format, kind, value) => {
    const decoded = await roundTrip(text, format);
    expect(decoded).toHaveLength(1);
    const c = classifyCode(decoded[0]);
    expect(c.kind).toBe(kind);
    expect(c.value).toBe(value);
  });
});
