# iPre — Hệ thống quản trị nhập hàng Apple (Mỹ → Việt Nam)

Dashboard cá nhân để quản lý toàn bộ vòng đời một chuyến hàng iPhone, iPad, Mac, AirPods… nhập từ Mỹ:
**nguồn hàng → đơn mua → vận chuyển 3 chặng (nội địa Mỹ · Mỹ → HN · HN → SG) → tồn kho → bán → thu chi → lãi lỗ**,
với mốc thời gian rõ ràng cho từng chặng và giá vốn chính xác đến từng đồng cho từng máy.

> **Trạng thái:** Giai đoạn lập kế hoạch. Bộ tài liệu thiết kế đã hoàn tất; mã nguồn ứng dụng sẽ bắt đầu ở GĐ0.

## Bộ tài liệu kế hoạch

| # | Tài liệu | Nội dung |
|---|---|---|
| 01 | [Nghiệp vụ & Quy trình](docs/01-nghiep-vu.md) | Thuật ngữ, quy trình, **10 mốc thời gian**, cấu trúc chi phí, công thức giá vốn & lãi lỗ, ví dụ tính toán, tình huống đặc biệt |
| 02 | [Kiến trúc & Công nghệ](docs/02-kien-truc.md) | So sánh phương án, stack công nghệ, sơ đồ kiến trúc, cấu trúc thư mục, triển khai, bảo mật |
| 03 | [Cơ sở dữ liệu](docs/03-co-so-du-lieu.md) | ERD, danh mục bảng, quyết định thiết kế, view báo cáo |
| 04 | [Backend](docs/04-backend.md) | Module, **costing engine**, máy trạng thái, bất biến nghiệp vụ, REST API, tác vụ định kỳ, kiểm thử |
| 05 | [Frontend](docs/05-frontend.md) | Sơ đồ trang, wireframe từng màn hình, component, quy ước hiển thị |
| 06 | [Lộ trình, Rủi ro & Pháp lý](docs/06-lo-trinh-rui-ro-phap-ly.md) | Các giai đoạn & tiêu chí nghiệm thu, rủi ro, thuế hộ kinh doanh 2026, nguồn gốc hàng hoá, câu hỏi cần xác nhận |

## Lược đồ cơ sở dữ liệu

- [`db/schema-draft.sql`](db/schema-draft.sql) — lược đồ PostgreSQL 16 (bảng, ràng buộc, view báo cáo).
- [`db/seed-vi-du.sql`](db/seed-vi-du.sql) — dữ liệu ví dụ khớp với phần "Ví dụ tính toán" ở tài liệu 01.

Chạy thử:

```bash
createdb ipre_draft
psql -d ipre_draft -f db/schema-draft.sql
psql -d ipre_draft -f db/seed-vi-du.sql
psql -d ipre_draft -c "select code, total_landed_cost_vnd, realized_profit_vnd, roi_on_sold_pct from v_batch_summary"
```

## Công nghệ dự kiến

TypeScript · Next.js (App Router) · Tailwind CSS + shadcn/ui · TanStack Table · Recharts · Drizzle ORM · PostgreSQL 16 · Better Auth (2FA) · Cloudflare R2 · Vitest + Playwright · GitHub Actions.
