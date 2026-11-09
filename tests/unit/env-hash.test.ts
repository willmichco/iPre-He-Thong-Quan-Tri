import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { afterAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";

// Next đọc .env.local bằng dotenv-expand: "$TÊN" bị thay (kể cả trong nháy đơn) → mã băm scrypt$… hỏng, không đăng nhập được.
// npm run auth:setup vì vậy in mã băm với "\$". Kiểm thử giữ quy tắc đó.
describe("mã băm mật khẩu trong .env.local", () => {
  const dir = mkdtempSync(join(tmpdir(), "ipre-env-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const read = (line: string) => {
    writeFileSync(join(dir, ".env"), `${line}\n`);
    delete process.env.IPRE_TEST_HASH;
    loadEnvConfig(dir, false, { info: () => {}, error: () => {} }, true);
    const v = process.env.IPRE_TEST_HASH;
    delete process.env.IPRE_TEST_HASH;
    return v;
  };

  it("viết \\$ thì Next đọc đúng; viết $ trần (kể cả nháy đơn) thì hỏng", async () => {
    const hash = await hashPassword("mat-khau-kiem-thu-2026");
    const escaped = read(`IPRE_TEST_HASH=${hash.replaceAll("$", "\\$")}`);
    expect(escaped).toBe(hash);
    expect(await verifyPassword("mat-khau-kiem-thu-2026", escaped!)).toBe(true);
    expect(read(`IPRE_TEST_HASH='${hash}'`)).not.toBe(hash);
  });
});
