/**
 * Nơi lưu tệp chứng từ. Hiện có ổ đĩa cục bộ (máy chủ tự quản / máy phát triển): thư mục ATTACHMENTS_DIR,
 * mặc định ./data/chung-tu. Khi chọn xong nơi triển khai (tài liệu 06 mục 5, câu 8) có thể thay bằng
 * kho đối tượng (R2 / S3) — chỉ cần một lớp cài đặt cùng giao diện `FileStore`.
 * Khoá luôn dạng "YYYY/MM/<sha256>.<đuôi>" (kiểm tra chặt → không thể ghi / đọc ra ngoài thư mục gốc).
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
}

const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f]{64}\.(pdf|jpg|png|webp|heic|heif)$/;

export function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error(`Khoá lưu trữ không hợp lệ: ${key}`);
}

export function localStore(root = process.env.ATTACHMENTS_DIR || join(process.cwd(), "data", "chung-tu")): FileStore {
  const base = resolve(root);
  const path = (key: string) => {
    assertKey(key);
    return join(base, key);
  };
  return {
    async put(key, bytes) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      // ghi tệp tạm rồi đổi tên → không bao giờ để lại tệp ghi dở
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    },
    get: (key) => readFile(path(key)),
    async has(key) {
      try {
        return (await stat(path(key))).isFile();
      } catch {
        return false;
      }
    },
  };
}

let store: FileStore | null = null;
export const fileStore = () => (store ??= localStore());
/** Cho kiểm thử: dùng thư mục tạm. */
export const setFileStore = (s: FileStore | null) => {
  store = s;
};
