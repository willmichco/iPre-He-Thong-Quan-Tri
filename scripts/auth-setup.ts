/**
 * Tạo tài khoản chủ: băm mật khẩu, sinh khoá TOTP (xác thực 2 lớp) và khoá phiên.
 *
 *   npm run auth:setup -- --email ban@example.com
 *
 * Mật khẩu được hỏi trong terminal (không hiện lên màn hình, không lưu vào lịch sử lệnh).
 * Kết quả: các dòng biến môi trường để dán vào .env.local (máy mình) hoặc phần
 * Environment Variables của nền tảng triển khai, cùng mã QR để quét bằng ứng dụng
 * Authenticator (Google Authenticator, 1Password, Apple Passwords…).
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { Secret } from "otpauth";
import { makeTotp } from "../src/server/auth/credentials";
import { hashPassword } from "../src/server/auth/password";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes("\n")) out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const email = (arg("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Cách dùng: npm run auth:setup -- --email ban@example.com");
    process.exit(1);
  }
  const password = process.env.OWNER_PASSWORD ?? (await askHidden("Mật khẩu mới (tối thiểu 12 ký tự): "));
  if (password.length < 12) {
    console.error("Mật khẩu quá ngắn — cần tối thiểu 12 ký tự.");
    process.exit(1);
  }
  if (!process.env.OWNER_PASSWORD) {
    const again = await askHidden("Nhập lại mật khẩu: ");
    if (again !== password) {
      console.error("Hai lần nhập không khớp.");
      process.exit(1);
    }
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = new Secret({ size: 20 }).base32;
  const sessionSecret = randomBytes(48).toString("base64url");
  const uri = makeTotp(totpSecret, email).toString();

  console.log("\n1) Quét mã QR này bằng ứng dụng Authenticator trên điện thoại:\n");
  console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
  console.log("   (hoặc nhập tay khoá:", totpSecret, ")\n");
  console.log("2) Đặt các biến môi trường sau (KHÔNG commit vào git):\n");
  console.log(`OWNER_EMAIL=${email}`);
  console.log(`OWNER_PASSWORD_HASH='${passwordHash}'`);
  console.log(`OWNER_TOTP_SECRET=${totpSecret}`);
  console.log(`SESSION_SECRET=${sessionSecret}`);
  console.log("\nĐổi SESSION_SECRET sẽ đăng xuất mọi thiết bị.");
}

main();
