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

## Bản xem thử trực tuyến

https://willmichco.github.io/iPre-He-Thong-Quan-Tri/ — **bản chụp tĩnh** toàn bộ giao diện trên dữ liệu mẫu (nhánh `gh-pages`, không có máy chủ):
xem được mọi màn hình, nút lưu chỉ báo thông báo. **Quét mã** chạy thật ngay trên máy; **Trợ lý** nhắn thử được — bộ đọc câu chạy trong trình duyệt,
câu trả lời dựng sẵn lúc chụp bằng chính hàm truy vấn của máy chủ (khớp số liệu các trang), phiếu ghi lập tại chỗ nhưng không lưu.

Chụp lại (sau mỗi lần thay đổi giao diện):

```bash
npm run db:seed && npm run demo:data      # CSDL dữ liệu mẫu riêng — KHÔNG chạy trên CSDL thật
npm run build && npm run build:standalone && npm run build:site   # → dist/site/, đẩy lên nhánh gh-pages
```

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

**Chứng từ đính kèm** (hoá đơn, vận đơn… dạng ảnh / PDF) được lưu trong thư mục `ATTACHMENTS_DIR` (mặc định `./data/chung-tu`, đã bỏ qua trong git). Khi triển khai lên dịch vụ không có ổ đĩa bền vững (vd Vercel), cần chuyển sang kho đối tượng (R2 / S3) — xem `src/server/attachments/storage.ts`. Xuất nhanh: trang **Cài đặt › Tải toàn bộ dữ liệu** xuất mọi bảng ra CSV.

### Sao lưu & khôi phục

```bash
BACKUP_KEY='chuỗi-ngẫu-nhiên-dài-≥16-ký-tự' npm run backup                 # tạo bản mã hoá + dọn bản cũ
npm run backup -- kiem-tra data/sao-luu/ipre-20261105-190000.ipbak         # giải mã + kiểm tra toàn vẹn
npm run backup -- khoi-phuc <tệp.ipbak> --vao postgres://…/ipre --dong-y-ghi-de
```

Mỗi bản `.ipbak` gồm `pg_dump` toàn bộ CSDL + mọi tệp chứng từ, mã hoá AES-256-GCM bằng `BACKUP_KEY` (**mất khoá là mất bản sao lưu** — cất khoá ở nơi riêng, ví dụ trình quản lý mật khẩu). Lưu ở `BACKUP_DIR` (mặc định `./data/sao-luu`), tự giữ 30 bản ngày gần nhất + 12 bản tháng. Chạy hằng ngày bằng cron (02:00 giờ VN = 19:00 UTC: `0 19 * * * cd /srv/ipre && npm run backup`) và chép `BACKUP_DIR` sang nơi khác máy chủ. Cần `pg_dump` / `pg_restore` **cùng phiên bản lớn với máy chủ** (pg_restore mới hơn máy chủ đích sẽ bị từ chối trước khi đụng vào dữ liệu); máy có nhiều bản thì đặt `PG_BIN=/usr/lib/postgresql/16/bin`. Kiểm thử `tests/integration/backup.test.ts` diễn tập khôi phục vào CSDL mới và so từng bảng.

### Trợ lý nhập liệu (`/tro-ly`)

Khung chat trong ứng dụng: nhắn tự nhiên để **ghi** (bán, cọc, thu nợ, nhập máy, thu chi, chi phí, chuyển tiền, thêm khách, số hoá đơn, giá mục tiêu)
hoặc **hỏi** (tồn kho, doanh thu / lãi, công nợ, số dư, kiện đang đi, việc cần xử lý, ngưỡng thuế…). Bộ đọc theo mẫu câu, chạy nội bộ, không gọi AI bên
ngoài. Mọi thao tác ghi đều qua **phiếu xem trước → Xác nhận** và dùng đúng dịch vụ của form tay. Tin chưa đủ thông tin vào **Bảng kê nháp**
(`/tro-ly/bang-ke`); **Bảng kê Excel** tải ở `/tro-ly/xuat?ky=thang` (hoặc nhắn "xuất excel tháng này"). Gõ "giúp" trong khung chat để xem câu mẫu.

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy máy phát triển |
| `npm run typecheck` · `npm run lint` | Kiểm tra kiểu dữ liệu · quy tắc mã |
| `npm test` | Kiểm thử đơn vị (nhận dạng mã, trích xuất chữ OCR, gom máy theo vị trí, đăng nhập, mã vạch thật → giải mã) |
| `npm run test:e2e` | Kiểm thử đầu-cuối bằng trình duyệt (máy tính, giả lập iPhone, 2 camera giả: nhãn hộp và màn hình Giới thiệu) |
| `npm run db:migrate` | Áp dụng migration còn thiếu (`db/migrations/*.sql`) |
| `npm run db:seed` | Migration + nạp dữ liệu ví dụ |
| `npm run build:standalone` | Đóng gói bộ quét thành bản chạy thử: `dist/quet-ma-thu.html` (một file) và `dist/pages/` (trang web cho GitHub Pages, nhánh `gh-pages`) |
| `npm run demo:data` · `npm run build:site` | Nạp dữ liệu mẫu cho bản xem thử · chụp bản xem thử tĩnh (`dist/site/`, cho nhánh `gh-pages`) |
| `npm run sample:label` | Tạo lại nhãn hộp mẫu `public/nhan-mau.svg` |

## Cấu trúc mã nguồn

```
src/
├── app/                    # Next.js: (app)/ khu vực đã đăng nhập · dang-nhap/ · api/health
├── domain/                 # Hàm thuần dùng chung trình duyệt + máy chủ: nhận dạng IMEI/Serial/Part No., gom máy
│   └── assistant/          # Trợ lý: đọc câu tiếng Việt (tiền, ngày, máy, khách…), ý định, bản nháp phiếu, câu trả lời
├── features/scanner/       # Bộ quét mã (camera, ảnh, máy quét USB, dán, nhập tay)
├── server/auth/            # Mật khẩu (scrypt), TOTP, phiên JWT, chống dò mật khẩu
├── server/db/              # Kết nối PostgreSQL
├── server/assistant/       # Trợ lý: điều phối hội thoại, trả lời câu hỏi, dựng / ghi phiếu, bảng kê nháp, xuất Excel
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
