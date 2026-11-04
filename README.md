# iPre — Hệ thống quản trị nhập hàng Apple (Mỹ → Việt Nam)

Dashboard cá nhân để quản lý toàn bộ vòng đời một chuyến hàng iPhone, iPad, Mac, AirPods… nhập từ Mỹ:
**nguồn hàng → đơn mua → vận chuyển 3 chặng (nội địa Mỹ · Mỹ → HN · HN → SG) → tồn kho → bán → thu chi → lãi lỗ**,
với mốc thời gian rõ ràng cho từng chặng và giá vốn chính xác đến từng đồng cho từng máy.

> **Trạng thái:** GĐ0 — nền móng. Đã có: khung ứng dụng Next.js, đăng nhập 2 lớp, CSDL + migration, CI, và **bộ quét mã dùng thử được** (`/quet-ma`). Các màn hình nghiệp vụ bắt đầu ở GĐ1.

## Bộ tài liệu kế hoạch

| # | Tài liệu | Nội dung |
|---|---|---|
| 01 | [Nghiệp vụ & Quy trình](docs/01-nghiep-vu.md) | Thuật ngữ, quy trình, **10 mốc thời gian**, cấu trúc chi phí, công thức giá vốn & lãi lỗ, ví dụ tính toán, tình huống đặc biệt |
| 02 | [Kiến trúc & Công nghệ](docs/02-kien-truc.md) | So sánh phương án, stack công nghệ, sơ đồ kiến trúc, cấu trúc thư mục, triển khai, bảo mật |
| 03 | [Cơ sở dữ liệu](docs/03-co-so-du-lieu.md) | ERD, danh mục bảng, quyết định thiết kế, view báo cáo |
| 04 | [Backend](docs/04-backend.md) | Module, **costing engine**, máy trạng thái, bất biến nghiệp vụ, REST API, tác vụ định kỳ, kiểm thử |
| 05 | [Frontend](docs/05-frontend.md) | Sơ đồ trang, wireframe từng màn hình, component, quy ước hiển thị |
| 06 | [Lộ trình, Rủi ro & Pháp lý](docs/06-lo-trinh-rui-ro-phap-ly.md) | Các giai đoạn & tiêu chí nghiệm thu, rủi ro, thuế hộ kinh doanh 2026, nguồn gốc hàng hoá, câu hỏi cần xác nhận |
| 07 | [Quét mã & Nhập liệu tay](docs/07-quet-ma-va-nhap-lieu.md) | **Quét IMEI/Serial/mã máy bằng camera và hình ảnh** (mã vạch, OCR, AI tuỳ chọn), Hộp chờ duyệt, form nhập tay, lưới nhập kiểu bảng tính |

## Chạy trên máy

Yêu cầu: Node.js 22+, Docker (cho PostgreSQL).

```bash
npm install
```

```bash
cp .env.example .env.local
```

```bash
docker compose up -d
```

```bash
npm run db:seed
```

```bash
npm run dev
```

Mở http://localhost:3000. Khi chưa cấu hình tài khoản chủ, máy phát triển cho vào thẳng kèm dải cảnh báo; môi trường thật luôn bắt buộc đăng nhập.

> Camera trên web chỉ chạy qua **HTTPS** (hoặc `localhost`). Muốn thử quét bằng iPhone với máy chạy local, dùng `next dev --experimental-https` hoặc triển khai lên môi trường thật.

### Cấu hình đăng nhập (một tài khoản chủ, xác thực 2 lớp)

```bash
npm run auth:setup -- --email ban@example.com
```

Lệnh hỏi mật khẩu (tối thiểu 12 ký tự), in mã QR để quét bằng ứng dụng Authenticator trên điện thoại, và in 4 biến môi trường `OWNER_EMAIL`, `OWNER_PASSWORD_HASH`, `OWNER_TOTP_SECRET`, `SESSION_SECRET` để dán vào `.env.local` hoặc phần Environment Variables của nơi triển khai. Đăng nhập cần đủ **email + mật khẩu + mã 6 số**; sai 5 lần trong 15 phút sẽ bị khoá 15 phút.

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy máy phát triển |
| `npm run typecheck` · `npm run lint` | Kiểm tra kiểu dữ liệu · quy tắc mã |
| `npm test` | Kiểm thử đơn vị (nhận dạng mã, gom máy, đăng nhập, mã vạch thật → giải mã) |
| `npm run test:e2e` | Kiểm thử đầu-cuối bằng trình duyệt (máy tính + giả lập iPhone) |
| `npm run db:migrate` | Áp dụng migration còn thiếu (`db/migrations/*.sql`) |
| `npm run db:seed` | Migration + nạp dữ liệu ví dụ |
| `npm run build:standalone` | Đóng gói bộ quét thành một file HTML chạy thử (`dist/quet-ma-thu.html`) |
| `npm run sample:label` | Tạo lại nhãn hộp mẫu `public/nhan-mau.svg` |

## Cấu trúc mã nguồn

```
src/
├── app/                    # Next.js: (app)/ khu vực đã đăng nhập · dang-nhap/ · api/health
├── domain/                 # Hàm thuần dùng chung trình duyệt + máy chủ: nhận dạng IMEI/Serial/Part No., gom máy
├── features/scanner/       # Bộ quét mã (camera, ảnh, máy quét USB, dán, nhập tay)
├── server/auth/            # Mật khẩu (scrypt), TOTP, phiên JWT, chống dò mật khẩu
├── server/db/              # Kết nối PostgreSQL
└── proxy.ts                # Chặn truy cập khi chưa đăng nhập
db/migrations/              # Migration SQL thuần, chạy theo thứ tự, có kiểm tra mã băm
scripts/                    # migrate, auth:setup, nhãn mẫu, đóng gói bản chạy thử
tests/unit · tests/e2e      # Vitest · Playwright
```

## Lược đồ cơ sở dữ liệu

- [`db/migrations/0001_khoi_tao.sql`](db/migrations/0001_khoi_tao.sql) — lược đồ PostgreSQL 16 (bảng, ràng buộc, view báo cáo).
- [`db/seed-vi-du.sql`](db/seed-vi-du.sql) — dữ liệu ví dụ khớp với phần "Ví dụ tính toán" ở tài liệu 01; CI kiểm tra số liệu khớp từng đồng.

## Công nghệ

TypeScript · Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · PostgreSQL 16 (`postgres`) · zxing-wasm (giải mã vạch WebAssembly) · jose + otpauth (phiên, 2FA) · Vitest · Playwright · GitHub Actions. Dự kiến thêm ở GĐ1: Drizzle ORM, TanStack Table, Recharts.
