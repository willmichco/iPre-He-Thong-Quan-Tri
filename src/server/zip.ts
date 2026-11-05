/**
 * ZIP tối giản (đủ cho .xlsx, gói xuất dữ liệu, bản sao lưu): ghi (deflate) và đọc (stored / deflate), kiểm CRC32.
 * Không hỗ trợ ZIP64 (tệp / gói > 4 GB) — quá lớn cho quy mô hộ kinh doanh; vượt ngưỡng thì báo lỗi rõ ràng.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const MAX32 = 0xffffffff;

/** Đóng gói ZIP (deflate). Tên tệp UTF-8; ngày giờ cố định 01/01/1980 để cùng dữ liệu cho cùng tệp. */
export function zip(files: readonly { name: string; data: string | Uint8Array }[], opts: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : Buffer.from(f.data);
    // store: dữ liệu đã nén / đã mã hoá (nén lại vô ích); còn lại deflate
    const comp = opts.store ? raw : deflateRawSync(raw, { level: 6 });
    if (raw.length > MAX32 || offset > MAX32) throw new Error("Gói ZIP vượt 4 GB — không hỗ trợ");
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(raw) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // phiên bản cần
    head.writeUInt16LE(0x0800, 6); // tên UTF-8
    head.writeUInt16LE(opts.store ? 0 : 8, 8); // 0 = stored, 8 = deflate
    head.writeUInt16LE(0, 10); // giờ
    head.writeUInt16LE(0x21, 12); // ngày 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(opts.store ? 0 : 8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    // trường phụ, chú thích, đĩa, thuộc tính = 0
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += head.length + name.length + comp.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Đọc ZIP: tên tệp → nội dung. Kiểm CRC32 từng tệp; tên chứa ".." hay đường dẫn tuyệt đối → lỗi (chống ghi ra ngoài). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buf.lastIndexOf(sig);
  if (end < 0 || end + 22 > buf.length) throw new Error("Không phải tệp ZIP hợp lệ");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Thư mục ZIP hỏng");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new Error(`Tên tệp không an toàn trong ZIP: ${name}`);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`Tệp ${name} trong ZIP hỏng`);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`Tệp ${name}: kiểu nén ${method} không hỗ trợ`);
    if (data.length !== usize || crc32(data) >>> 0 !== crc) throw new Error(`Tệp ${name} trong ZIP sai mã kiểm (CRC) — tệp bị hỏng`);
    if (!name.endsWith("/")) out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
