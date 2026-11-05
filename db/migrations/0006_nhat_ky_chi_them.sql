-- =============================================================================
-- 0006 — Nhật ký kiểm toán CHỈ THÊM (tài liệu 04: "mọi thao tác ghi để lại dấu vết").
--
-- 1. Dọn dữ liệu cá nhân cũ: nhật ký tạo đơn bán từng ghi tên + SĐT khách. Nhật ký sắp bị khoá
--    không sửa được, nên ẩn danh hoá khách (Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15) sẽ không xoá
--    được các dòng này → thay bằng mã khách (customerId) ngay trước khi khoá. Từ bản này, ứng dụng
--    chỉ ghi mã khách.
-- 2. Khoá: chặn UPDATE / DELETE / TRUNCATE trên audit_logs (ứng dụng, lệnh SQL thường đều bị từ chối).
--    Sao lưu → khôi phục (pg_restore --clean) xoá bảng bằng DROP nên không bị ảnh hưởng.
-- =============================================================================

UPDATE audit_logs a
   SET after = (a.after - 'customerName' - 'customerPhone') || jsonb_build_object('customerId', s.customer_id)
  FROM sales s
 WHERE a.entity_type = 'sale' AND a.action = 'CREATE' AND a.entity_id = s.id
   AND (a.after ? 'customerName' OR a.after ? 'customerPhone');

UPDATE audit_logs
   SET after = after - 'customerName' - 'customerPhone'
 WHERE entity_type = 'sale' AND (after ? 'customerName' OR after ? 'customerPhone');

CREATE FUNCTION audit_logs_chi_them() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs chỉ được thêm dòng — không sửa / xoá nhật ký kiểm toán'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_khong_sua_xoa
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chi_them();

CREATE TRIGGER audit_logs_khong_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_chi_them();
