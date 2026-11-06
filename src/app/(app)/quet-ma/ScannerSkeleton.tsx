/** Khung chờ trong lúc tải bộ quét (WebAssembly + mã camera): đúng bố cục thật nên không bị nhảy trang khi hiện ra. */
export function ScannerSkeleton({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={`mx-auto max-w-[1180px] ${embedded ? "p-3.5" : "p-4"}`} aria-busy="true">
      <span className="sr-only">Đang tải bộ quét…</span>
      <div className="skeleton h-7 w-44" />
      <div className="skeleton mt-2 h-4 w-60" />
      <div className="skeleton mt-4 h-[52px] rounded-[18px]" />
      <div className="card mt-3 rounded-[24px] p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="skeleton h-14 rounded-2xl" />
          <div className="skeleton h-14 rounded-2xl" />
        </div>
        <div className="mt-3 aspect-[4/5] max-h-[64svh] w-full rounded-[20px] bg-[#0b0e15] sm:aspect-[4/3]" />
      </div>
    </div>
  );
}
