# Chạy iPre trên máy của bạn + mở ra ngoài qua Cloudflare

Một người dùng thì không cần VPS. Theo cách này:
- iPre và PostgreSQL chạy ngay trên máy tính của bạn, dữ liệu nằm trên ổ cứng của bạn.
- **Cloudflare Tunnel** cấp một đường dẫn `https://…` để mở từ iPhone ở bất kỳ đâu.
  Có HTTPS nên camera quét IMEI chạy được.
- Máy bạn không mở cổng nào ra Internet. iPre chỉ nghe `127.0.0.1`, đường ra ngoài duy nhất là đường hầm tới Cloudflare.

| | |
|---|---|
| Chi phí | 0 đ (đường dẫn tạm), hoặc khoảng 250 nghìn đ/năm nếu muốn tên miền riêng cố định |
| Điều kiện | Máy tính đang bật và cửa sổ iPre đang mở. Tắt máy thì web tắt, dữ liệu vẫn còn. |
| Bảo mật | Đăng nhập email + mật khẩu + mã 6 số (bắt buộc). Có thể thêm lớp Cloudflare Access (mục 4). |

## 1. Cài một lần

1. **Node.js 22+**: https://nodejs.org (bản LTS).
2. **Docker Desktop**: https://www.docker.com/products/docker-desktop/. Mở Docker lên và để chạy nền.
   Nếu đã có PostgreSQL 16 thì bỏ qua bước này, chỉ cần sửa `DATABASE_URL`.
3. **cloudflared**:
   - Windows: `winget install --id Cloudflare.cloudflared`
   - macOS: `brew install cloudflared`
4. Tải mã nguồn iPre về một thư mục (GitHub → Code → Download ZIP, hoặc `git clone`).
5. **Tạo tài khoản đăng nhập** (bắt buộc, vì web sẽ mở ra ngoài):
   ```bash
   npm install
   npm run auth:setup -- --email ban@example.com
   ```
   Dán 4 dòng lệnh in ra vào tệp `.env.local`. Nếu chưa có tệp này, chép `.env.example` thành `.env.local`.
6. **Nên làm: bật sao lưu tự động.** Thêm vào `.env.local` một dòng `BACKUP_KEY=<chuỗi ngẫu nhiên ≥ 16 ký tự>` và cất khoá ở chỗ khác.
   Khi đó mỗi ngày iPre tự tạo bản sao lưu mã hoá vào `data/sao-luu/`.
   Chép thư mục đó sang Google Drive hoặc USB định kỳ.

## 2. Mỗi lần dùng

Bấm đúp:
- **Windows**: `khoi-dong-ipre.bat`
- **macOS**: `khoi-dong-ipre.command`. Lần đầu: chuột phải → Mở, vì macOS chặn tệp tải từ Internet.

Hoặc gõ trong terminal: `npm run may:cloudflare`. Chỉ dùng trên máy này thì gõ `npm run may`.

Bộ khởi động tự làm các việc sau:
1. bật PostgreSQL;
2. cập nhật cấu trúc CSDL;
3. build lại nếu mã nguồn đổi;
4. sao lưu nếu tới hạn;
5. chạy iPre;
6. mở đường hầm Cloudflare.

Xong, nó **in đường dẫn kèm mã QR**, bạn quét bằng iPhone là vào. Trong lúc chạy, nó còn:
- sao lưu mỗi ngày;
- chạy bot theo dõi vận đơn lúc 07:00 và 19:00, nếu đã có khoá UPS hoặc 17TRACK.

Để cửa sổ đó mở. Đóng cửa sổ (hoặc Ctrl+C) là dừng.

> Trên iPhone: mở đường dẫn trong Safari → Chia sẻ → **Thêm vào MH chính**. iPre sẽ hiện như một ứng dụng.

## 3. Đường dẫn cố định (tên miền riêng)

Không cấu hình gì thì bạn dùng **đường dẫn tạm** dạng `https://abc-xyz.trycloudflare.com`.

| Đặc điểm | Hệ quả |
|---|---|
| Không cần tài khoản Cloudflare | Dùng được ngay |
| Mỗi lần khởi động ra địa chỉ khác | Phải quét lại mã QR |
| Cloudflare chỉ dành nó để thử, không cam kết duy trì | Không nên dùng lâu dài |

Muốn địa chỉ cố định, ví dụ `https://ipre.tenmien.vn`:
1. Tạo tài khoản Cloudflare (miễn phí) và đưa một tên miền của bạn vào Cloudflare (Add a domain, đổi nameserver theo hướng dẫn).
2. Vào **Zero Trust → Networks → Tunnels → Create a tunnel**, chọn loại *Cloudflared*, đặt tên `ipre`.
   Bỏ qua phần cài đặt, chỉ **chép token** (chuỗi dài sau `--token`).
3. Trong tunnel vừa tạo, mục **Public hostname**, thêm:
   - Subdomain: `ipre`
   - Domain: tên miền của bạn
   - Service: `HTTP` · `localhost:3000`
4. Thêm vào `.env.local`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=<token vừa chép>
   IPRE_PUBLIC_URL=https://ipre.tenmien.vn
   ```

Từ lần sau bộ khởi động tự nối vào tunnel này và in mã QR cho địa chỉ cố định.
Token này là bí mật: ai có nó thì trỏ được tên miền của bạn về máy họ. Đừng gửi qua chat và đừng commit lên GitHub. Tệp `.env.local` đã được git bỏ qua.

## 4. Thêm lớp khoá Cloudflare Access (tuỳ chọn)

Áp dụng khi dùng tên miền riêng. Cloudflare sẽ chặn trước cả trang đăng nhập iPre: chỉ ai nhập đúng email của bạn và mã gửi về email mới qua được.
1. Vào **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Domain: `ipre.tenmien.vn`.
3. Thêm policy *Allow*, Include → *Emails* → email của bạn.
4. Phương thức đăng nhập: *One-time PIN*.

Khi đó kẻ lạ không thấy được cả trang đăng nhập.
Gói miễn phí của Zero Trust cho tối đa 50 người dùng, đủ cho một người.

## 5. Lưu ý

- **Dữ liệu là của bạn và nằm trên máy bạn.** Hỏng hoặc mất máy mà không có bản sao lưu ở nơi khác là mất dữ liệu. Vì vậy:
  - bật `BACKUP_KEY`;
  - chép `data/sao-luu/` ra ngoài máy định kỳ;
  - giữ kín `BACKUP_KEY`, vì mất khoá thì không mở được bản sao lưu.
- Cloudflare chỉ chuyển dữ liệu qua (có mã hoá HTTPS giữa iPhone và Cloudflare), không lưu CSDL của bạn.
  Dữ liệu khách hàng (tên, SĐT) vẫn do bạn quản lý theo Luật Bảo vệ dữ liệu cá nhân. Trang Cài đặt có chức năng xoá / ẩn danh dữ liệu khách.
- Đừng để máy ngủ khi đang cần dùng từ xa:
  - Windows: Settings → Power → Sleep: Never (khi cắm sạc);
  - macOS: System Settings → Battery/Energy → bật "Prevent automatic sleeping".
- Cập nhật iPre: tải mã mới về (hoặc `git pull`), rồi bấm đúp lại. Bộ khởi động tự build lại và cập nhật CSDL.
- Muốn chạy 24/7 không phụ thuộc máy tính thì mới cần VPS hoặc máy chủ.
  Mọi thứ ở trên vẫn dùng được, chỉ khác là chạy trên máy chủ đó.
