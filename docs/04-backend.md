# 04 — Backend: Module, Nghiệp vụ & API

## 1. Phân lớp

```
┌──────────────────────────────────────────────────────────────┐
│  Giao tiếp:   Server Actions (form)  ·  REST /api/v1  ·  Cron │  ← kiểm tra đầu vào bằng Zod, xác thực
├──────────────────────────────────────────────────────────────┤
│  Services:    use case + transaction + audit log              │  ← "làm gì": tạo đơn mua, gửi kiện, bán…
├──────────────────────────────────────────────────────────────┤
│  Domain:      hàm thuần (không DB, không I/O)                 │  ← "tính thế nào": phân bổ, giá vốn, lãi, trạng thái
├──────────────────────────────────────────────────────────────┤
│  Hạ tầng:     Drizzle (PostgreSQL) · R2 · Telegram · Tỷ giá   │
└──────────────────────────────────────────────────────────────┘
```

**Quy tắc bất di bất dịch:** mọi con số tiền và mọi chuyển trạng thái chỉ được tính ở tầng **Domain**. Giao diện và API không tự tính lãi/giá vốn — chỉ hiển thị kết quả từ Domain/view.

---

## 2. Danh sách module

| Module | Trách nhiệm chính |
|---|---|
| `catalog` | Mẫu máy, cấu hình, nơi mua, đơn vị vận chuyển, tài khoản, danh mục thu chi, khách hàng |
| `batches` | Vòng đời chuyến; chốt chi phí / mở lại; tổng hợp lãi lỗ chuyến |
| `purchasing` | Đơn mua, thêm máy hàng loạt (dán danh sách serial/IMEI hoặc quét), đối soát subtotal |
| `inventory` | Hồ sơ máy, tìm theo IMEI/Serial, sự kiện thủ công (hư hỏng, dùng cá nhân…), giá mục tiêu |
| `shipping` | Kiện/chặng, gán máy vào kiện, "Gửi đi" / "Đã nhận" / "Giữ hải quan", tracking, ETA |
| `costing` | **Bộ máy tính giá vốn**: phân bổ, ghi `item_cost_allocations`, tính lại khi dữ liệu đổi |
| `sales` | Đơn bán, cọc, thu tiền nhiều lần, huỷ, khách trả lại, bảo hành |
| `ledger` | Sổ thu chi, số dư tài khoản, chuyển tiền nội bộ, đối soát |
| `reporting` | Truy vấn view, báo cáo theo kỳ/chuyến/dòng máy/kênh, xuất Excel |
| `fx` | Tỷ giá tham khảo hằng ngày, gợi ý tỷ giá khi nhập liệu |
| `attachments` | Tải lên chứng từ (presigned URL), xem, xoá mềm |
| `scanning` | Nhận kết quả quét từ trình duyệt, **kiểm tra lại** (Luhn, trùng, ngữ cảnh), Hộp chờ duyệt, khớp `variant_codes`, xác nhận thành máy; gọi AI đọc ảnh nếu được bật — xem [tài liệu 07](07-quet-ma-va-nhap-lieu.md) |
| `alerts` | Quy tắc cảnh báo + gửi Telegram |
| `audit` | Ghi và tra cứu nhật ký thay đổi |
| `data-io` | Nhập từ Excel/CSV (chuyển dữ liệu cũ), xuất toàn bộ dữ liệu |
| `auth` | Đăng nhập, 2FA, phiên |

---

## 3. Bộ máy tính giá vốn (Costing engine)

### 3.1. Thuật toán phân bổ (phần dư lớn nhất)

```ts
// Bản đã triển khai: src/domain/costing/allocation.ts — bigint thuần (không cần thư viện số thập phân)
// Dưới đây là phác thảo ban đầu, giữ để đối chiếu thuật toán.
export function allocate(totalVnd: bigint, weights: Decimal[]): bigint[] {
  if (weights.length === 0) throw new DomainError('Không có máy để phân bổ');
  const sumW = Decimal.sum(...weights);
  if (sumW.lte(0)) throw new DomainError('Tổng trọng số phải > 0');

  const sign = totalVnd < 0n ? -1n : 1n;           // hỗ trợ khoản âm (hoàn phí, giảm giá)
  const abs = totalVnd * sign;
  const raw = weights.map(w => new Decimal(abs.toString()).mul(w).div(sumW));
  const base = raw.map(r => BigInt(r.floor().toFixed(0)));
  let remainder = abs - base.reduce((a, b) => a + b, 0n);

  // Cộng 1 đồng cho các máy có phần lẻ lớn nhất (hoà thì theo thứ tự ổn định)
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(r.floor()) }))
    .sort((a, b) => b.frac.cmp(a.frac) || a.i - b.i);
  for (let k = 0; remainder > 0n; k++, remainder--) base[order[k].i] += 1n;

  return base.map(v => v * sign);
}
```

**Thuộc tính bắt buộc (kiểm thử tự động với hàng nghìn bộ dữ liệu ngẫu nhiên):**
1. `Σ kết quả === totalVnd` — luôn luôn, không lệch 1 đồng.
2. Mỗi phần chênh với tỷ lệ lý thuyết không quá 1 đồng.
3. Cùng đầu vào → cùng đầu ra (tất định).

### 3.2. Tính giá vốn một chuyến

```ts
// Bản đã triển khai: src/domain/costing/costing.ts (thêm làm tròn luỹ kế cho thành phần đơn mua)
export function computeAllocations(input: BatchCostingInput): Allocation[] {
  const out: Allocation[] = [];

  for (const po of input.purchaseOrders) {
    const items = po.items;
    const priceVnd = items.map(i => toVnd(i.unitPrice, po.fxRate));      // đơn giá × tỷ giá
    items.forEach((it, k) => out.push({ itemId: it.id, component: 'PRICE', amountVnd: priceVnd[k] }));

    const byValue = priceVnd.map(v => new Decimal(v.toString()));
    pushAllocated(out, items, 'SALES_TAX',       allocate(toVnd(po.salesTax, po.fxRate), byValue));
    pushAllocated(out, items, 'SELLER_SHIPPING', allocate(toVnd(po.sellerShipping, po.fxRate), byValue));
    pushAllocated(out, items, 'DISCOUNT',        allocate(-toVnd(po.discount, po.fxRate), byValue));
    pushAllocated(out, items, 'PO_FX_FEE',       allocate(po.fxFeeVnd, byValue));
  }

  for (const cost of input.costs) {                   // chi phí gắn chuyến / đơn mua / kiện / máy
    const targets = resolveTargets(cost, input);      // các máy thuộc đối tượng được gắn
    const shares = cost.allocationMethod === 'MANUAL'
      ? manualShares(cost, targets)                   // phải cộng đúng bằng amountVnd, nếu không → lỗi
      : allocate(cost.amountVnd, weightsFor(cost.allocationMethod, targets, out));
    pushAllocated(out, targets, cost.kind, shares, { costId: cost.id, isEstimate: cost.isEstimate });
  }
  return out.filter(a => a.amountVnd !== 0n);
}
```

- **Trọng số theo giá trị** dùng *giá mua VND* của máy (đã tính ở bước trên).
- **Trọng số theo cân nặng** dùng `items.weight_kg` hoặc mặc định của cấu hình máy; thiếu cân nặng → báo lỗi rõ ràng, yêu cầu nhập.
- Máy đã **trả người bán** bị loại khỏi tập phân bổ (tuỳ chọn trong cài đặt: phân bổ lại hoặc ghi lỗ).

### 3.3. Khi nào tính lại?

> Bản đã triển khai: `src/server/costing/service.ts` (`recalculateBatch(es)`, `finalizeBatchCosts`, `reopenBatchCosts`, `recalculateSale`); kiểm thử tích hợp `tests/integration/costing-service.test.ts`.

Service gọi `recalculateBatch(batchId)` **trong cùng transaction** sau bất kỳ thao tác nào sau đây: tạo/sửa/xoá đơn mua, máy, chi phí; gán/bỏ máy khỏi kiện; sửa tỷ giá. Nếu kiện gom nhiều chuyến → tính lại tất cả chuyến liên quan. Thao tác nhanh (vài mili-giây cho vài trăm máy) nên không cần hàng đợi.

**Chặn khi đã chốt:** nếu chuyến ở trạng thái `COSTS_FINALIZED`/`CLOSED`, mọi thao tác làm thay đổi giá vốn trả lỗi `BATCH_FINALIZED` — phải gọi "Mở lại chuyến" (kèm lý do, ghi audit).

---

## 4. Máy trạng thái & mốc thời gian

### 4.1. Thao tác trên kiện → sự kiện cho mọi máy trong kiện

| Chặng | "Gửi đi" sinh sự kiện | "Đã nhận" sinh sự kiện | Trạng thái máy sau khi nhận |
|---|---|---|---|
| ① Nội địa Mỹ | `SELLER_SHIPPED` → `US_IN_TRANSIT` | `US_WAREHOUSE_RECEIVED` | `AT_US_WAREHOUSE` |
| ② Mỹ → VN | `INTL_DEPARTED` → `INTL_IN_TRANSIT` | `HN_ARRIVED` | `AT_HN` |
| ③ HN → SG | `DOMESTIC_DEPARTED` → `DOMESTIC_IN_TRANSIT` | `SG_RECEIVED` | `IN_STOCK` (hoặc giữ `RESERVED` nếu khách đã cọc) |

### 4.2. Quy tắc hợp lệ
- Không thể "Đã nhận" kiện chưa "Gửi đi" (trừ khi nhập cả hai mốc cùng lúc cho dữ liệu cũ).
- Không thể bán máy ở trạng thái `LOST`, `DAMAGED`, `RETURNED_TO_SELLER`, `PERSONAL_USE`, hoặc đã có dòng bán hiệu lực.
- Máy chưa về SG **được phép** gắn đơn bán dạng "Đã cọc" (đặt trước); chỉ được chuyển "Hoàn tất" khi máy đã về SG — trừ khi người dùng xác nhận bán giao thẳng.
- Sửa thời điểm của một mốc → ghi sự kiện điều chỉnh, không xoá sự kiện cũ (giữ lịch sử).
- Chuyến tự chuyển trạng thái theo máy: có máy đang vận chuyển → `IN_TRANSIT`; tất cả đã về SG → `ARRIVED`; tất cả đã bán và đã chốt → gợi ý `CLOSED`.

---

## 5. Bất biến nghiệp vụ (kiểm tra ở Service + test)

1. Σ đơn giá các máy của đơn mua = `subtotal` (lệch → cảnh báo vàng, không chặn, vì có thể còn máy chưa nhập).
2. Σ `item_cost_allocations` của một chi phí = `amount_vnd` của chi phí đó.
3. Σ giá vốn các máy của chuyến = Σ `total_vnd` các đơn mua + Σ chi phí của chuyến (đối soát tự động, hiển thị trong tab Lãi lỗ).
4. Số dư tài khoản không âm với loại `CASH` (cảnh báo).
5. Tổng tiền đã thu của đơn bán ≤ tổng phải thu (trừ khi ghi nhận "khách trả dư").
6. Mỗi chuyến chỉ được chốt chi phí khi: không còn máy ở trạng thái vận chuyển, không còn chi phí `is_estimate = true`.

---

## 6. REST API (`/api/v1`)

Tất cả yêu cầu cần phiên đăng nhập hợp lệ. Phản hồi JSON; lỗi theo dạng `{ error: { code, message, details } }`. Danh sách có phân trang `?page=&pageSize=` và sắp xếp `?sort=-createdAt`.

| Nhóm | Phương thức & đường dẫn | Chức năng |
|---|---|---|
| **Danh mục** | `GET/POST /models`, `/variants`, `/suppliers`, `/carriers`, `/accounts`, `/customers` · `PATCH/DELETE /…/:id` | CRUD danh mục |
| **Chuyến hàng** | `GET /batches?status=` | Danh sách + tóm tắt lãi lỗ |
| | `POST /batches` · `GET/PATCH /batches/:id` | Tạo / xem chi tiết (đơn mua, máy, kiện, chi phí, dòng thời gian, lãi lỗ) / sửa |
| | `POST /batches/:id/finalize-costs` · `POST /batches/:id/reopen` | Chốt chi phí / mở lại (bắt buộc lý do) |
| | `POST /batches/:id/recalculate` | Tính lại giá vốn (dự phòng) |
| **Đơn mua** | `GET/POST /purchase-orders` · `GET/PATCH /purchase-orders/:id` | CRUD đơn mua |
| | `POST /purchase-orders/:id/items` | Thêm nhiều máy một lần (danh sách serial/IMEI, cấu hình, đơn giá) |
| **Máy** | `GET /items?status=&category=&batchId=&q=` | Tìm kiếm, lọc (q = IMEI/Serial/ghi chú) |
| | `GET /items/lookup?code=` | Tra nhanh khi quét mã vạch |
| | `GET/PATCH /items/:id` | Hồ sơ máy: giá vốn chi tiết, dòng thời gian, lịch sử bán, chứng từ |
| | `POST /items/:id/events` | Ghi sự kiện thủ công (hư hỏng, dùng cá nhân, bảo hành…) |
| **Vận chuyển** | `GET /shipments?legType=&status=&overdue=true` | Bảng tiến độ kiện |
| | `POST /shipments` · `GET/PATCH /shipments/:id` | Tạo / sửa kiện |
| | `PUT /shipments/:id/items` | Gán danh sách máy vào kiện |
| | `POST /shipments/:id/depart` · `POST /shipments/:id/arrive` · `POST /shipments/:id/hold` | Gửi đi / Đã nhận / Giữ hải quan (kèm thời điểm) |
| | `POST /shipments/:id/tracking-events` | Thêm mốc tracking |
| **Chi phí** | `GET/POST /costs` · `PATCH/DELETE /costs/:id` | CRUD chi phí (tự tính lại giá vốn) |
| **Bán hàng** | `GET/POST /sales` · `GET/PATCH /sales/:id` | Tạo đơn bán (kèm xem trước lãi), sửa |
| | `POST /sales/:id/payments` | Ghi nhận cọc / thanh toán |
| | `POST /sales/:id/complete` · `POST /sales/:id/cancel` | Hoàn tất / huỷ |
| | `POST /sales/:id/returns` | Khách trả lại máy (hoàn tiền, máy về kho) |
| | `POST /sales/preview` | Xem trước giá vốn & lãi trước khi chốt giá với khách |
| **Thu chi** | `GET/POST /cash-transactions` · `PATCH/DELETE /cash-transactions/:id` | Sổ thu chi (chỉ sửa được bút toán nhập tay) |
| | `POST /transfers` | Chuyển tiền / đổi ngoại tệ giữa tài khoản |
| | `GET /accounts/balances?at=` | Số dư từng tài khoản tại thời điểm |
| **Báo cáo** | `GET /reports/overview?from=&to=` | Số liệu trang Tổng quan |
| | `GET /reports/pnl?groupBy=month\|category\|batch\|channel&from=&to=` | Lãi lỗ theo chiều |
| | `GET /reports/inventory-aging` · `GET /reports/capital-by-stage` | Tồn kho, vốn theo chặng |
| | `GET /reports/lead-times?groupBy=carrier\|leg&from=&to=` | Thời gian vận chuyển |
| | `GET /reports/cash-flow?from=&to=` | Dòng tiền |
| | `GET /reports/tax-revenue?year=` | Sổ doanh thu theo kỳ phục vụ kê khai |
| | `GET /reports/:name/export?format=xlsx` | Xuất Excel |
| **Tỷ giá** | `GET/POST /exchange-rates` · `POST /exchange-rates/sync` | Tra cứu / nhập tay / đồng bộ |
| **Chứng từ** | `POST /attachments/presign` · `POST /attachments` · `DELETE /attachments/:id` | Tải lên và quản lý |
| **Quét mã** | `POST /scans` · `GET /scans?status=` · `PATCH /scans/:id` · `POST /scans/:id/confirm` · `POST /scans/:id/discard` · `POST /scans/:id/ai-read` | Quét / Hộp chờ duyệt / xác nhận — chi tiết tại [tài liệu 07, mục 7](07-quet-ma-va-nhap-lieu.md) |
| | `GET /variants/resolve?code=` · `POST /variant-codes` | Part No./UPC → cấu hình; ghi nhớ mã mới |
| | `POST /purchase-orders/:id/items/bulk` | Lưu cả lưới nhập máy trong một transaction |
| **Hệ thống** | `GET /audit-logs?entityType=&entityId=` · `POST /export/all` | Nhật ký; xuất toàn bộ dữ liệu (ZIP) |

---

## 7. Tác vụ định kỳ & cảnh báo

| Tác vụ | Lịch | Hành động |
|---|---|---|
| Đồng bộ tỷ giá tham khảo | 08:30 hằng ngày | Lưu `exchange_rates`; nhắc nếu biến động > 1% so với hôm trước |
| Kiện quá hạn | 09:00 hằng ngày | Kiện có `eta + số ngày ân hạn < hôm nay` mà chưa nhận → cảnh báo |
| Kiện bị giữ hải quan | 09:00 hằng ngày | Kiện `HOLD` → nhắc kèm số ngày bị giữ |
| Tồn kho lâu | 09:00 thứ Hai | Máy tồn > N ngày (mặc định 30) → danh sách gợi ý xả, kèm giá vốn và giá thị trường |
| Hạn đổi trả người bán Mỹ | 09:00 hằng ngày | Đơn mua còn ≤ 3 ngày tới `return_deadline` mà máy có vấn đề → nhắc |
| Ngưỡng doanh thu năm | Khi ghi nhận bán | Doanh thu luỹ kế ≥ 80% ngưỡng cấu hình → cảnh báo (xem tài liệu 06) |
| Công nợ | 09:00 thứ Hai | Khách còn nợ, forwarder chưa thanh toán |
| Sao lưu | 02:00 hằng ngày | `pg_dump` mã hoá → R2; giữ 30 bản ngày + 12 bản tháng |
| Đồng bộ tracking *(giai đoạn 3)* | Mỗi 3 giờ | Lấy mốc mới từ API vận chuyển → ghi `shipment_tracking_events`; tự gợi ý "Đã nhận" |

**Mẫu tin Telegram:**

```
⚠️ iPre — 2 kiện quá hạn dự kiến
• AWB-0001 (Mỹ → VN, Forwarder A): ETA 16/10, trễ 2 ngày — 3 máy, vốn 55,9 tr
• HNSG-0007 (HN → SG, Chành xe B): ETA 21/10, trễ 1 ngày — 5 máy, vốn 128,4 tr
→ Mở bảng tiến độ: https://…/van-chuyen?overdue=true
```

---

## 8. Nhập / xuất dữ liệu

- **Nhập từ Excel/CSV** (chuyển dữ liệu cũ): mẫu file có sẵn cho máy, đơn mua, chi phí, đơn bán. Quy trình 3 bước: tải lên → hệ thống kiểm tra, báo lỗi từng dòng (trùng IMEI, thiếu cấu hình…) → xác nhận nhập trong một transaction (lỗi là huỷ toàn bộ).
- **Xuất:** mọi bảng/báo cáo xuất Excel; "Xuất toàn bộ dữ liệu" ra ZIP (CSV từng bảng + file Excel tổng hợp) — dữ liệu luôn thuộc về chủ hàng.

---

## 9. Chiến lược kiểm thử

| Mức | Phạm vi | Công cụ | Mục tiêu |
|---|---|---|---|
| Unit | `domain/*`: phân bổ, giá vốn, lãi, trạng thái, tiền tệ, **phân loại mã (IMEI/Serial/Part No.)** | Vitest + fast-check | **≥ 95% độ phủ**; kiểm thử thuộc tính cho phân bổ |
| Bộ ảnh mẫu | ≥ 50 ảnh thật: nhãn hộp, màn hình *Giới thiệu*, ảnh khó, hoá đơn | Vitest + zxing-wasm trên Node | Tỉ lệ tự đọc không được tụt sau mỗi lần sửa (tài liệu 07, mục 9) |
| Tích hợp | Services với PostgreSQL thật (container trong CI) | Vitest | Transaction, ràng buộc, tính lại giá vốn |
| Đối chiếu | Bộ dữ liệu chuẩn (ví dụ tài liệu 01 + 2–3 chuyến thật đã tính tay bằng Excel) | Vitest | **Sai lệch = 0 đồng** |
| E2E | Tạo chuyến → đơn mua → kiện 3 chặng → bán → xem lãi | Playwright | Các luồng chính không gãy khi cập nhật |

---

## 10. Xử lý lỗi & ghi log

- Lỗi nghiệp vụ có mã rõ ràng (`BATCH_FINALIZED`, `ITEM_ALREADY_SOLD`, `DUPLICATE_IMEI`, `MISSING_WEIGHT`…) và thông điệp tiếng Việt dễ hiểu.
- Lỗi hệ thống ghi log có mã truy vết; không lộ chi tiết kỹ thuật ra giao diện.
- Mọi thao tác ghi đều **idempotent** với khoá yêu cầu (tránh bấm đúp tạo hai đơn bán).
