/**
 * Khung chờ khi chuyển trang: hiện ngay lập tức (được tải trước cùng liên kết), nội dung thật thay vào khi máy chủ trả về.
 * Không có tiêu đề / chữ thật để không lẫn với nội dung trang.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Đang tải…</span>
      <div className="skeleton h-8 w-48" />
      <div className="skeleton mt-4 h-9 w-72 rounded-full" />
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="card h-28 p-4">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton mt-3 h-7 w-20" />
            <div className="skeleton mt-3 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="card mt-5 p-4">
        {[0, 1, 2, 3, 4].map((k) => (
          <div key={k} className="skeleton mt-3 h-4 first:mt-0" style={{ width: `${90 - k * 9}%` }} />
        ))}
      </div>
    </main>
  );
}
