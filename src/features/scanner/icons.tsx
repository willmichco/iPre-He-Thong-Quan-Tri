/**
 * Biểu tượng nét mảnh cho bộ quét (SVG tự vẽ, 24×24, theo màu chữ). Không phụ thuộc Next.js — dùng được cả ở
 * bản chạy thử độc lập. Luôn aria-hidden: nghĩa đã có ở nhãn chữ / aria-label của nút.
 */
const PATHS = {
  camera: (
    <>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8A1.5 1.5 0 0 1 10.6 3.5h2.8a1.5 1.5 0 0 1 1.3.7L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.2" r="3.4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m20.5 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L6 18.7" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="3" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9" />
    </>
  ),
  barcode: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 9v6M11 9v6M14 9v6M17 9v6" />
    </>
  ),
  phone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.8" />
      <path d="M9.5 8h5M9.5 11h5M9.5 14h3" />
    </>
  ),
  torch: (
    <>
      <path d="M8 3h8l-1.5 5.5v1.3a2 2 0 0 1-.6 1.4L13 12.2V20a1 1 0 0 1-1 1h0a1 1 0 0 1-1-1v-7.8l-.9-1A2 2 0 0 1 9.5 9.8V8.5z" />
      <path d="M9.5 8.5h5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7.1 6.3a7.5 7.5 0 1 0 9.8 0" />
    </>
  ),
  next: <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />,
  send: <path d="M4.5 12 19.5 4.5l-4 15-3.5-6.2zM12 13.3l7.5-8.8" />,
  trash: <path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7" />,
  warn: (
    <>
      <path d="M10.3 4.2 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 16.8h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8h.01" />
    </>
  ),
  upload: <path d="M12 16V5M7 9.5l5-5 5 5M5 19.5h14" />,
  paste: (
    <>
      <rect x="5.5" y="4.5" width="13" height="16" rx="2.5" />
      <path d="M9 4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5V6H9z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  sparkle: <path d="M12 3.5 13.6 9a2 2 0 0 0 1.4 1.4l5.5 1.6-5.5 1.6a2 2 0 0 0-1.4 1.4L12 20.5 10.4 15A2 2 0 0 0 9 13.6L3.5 12 9 10.4A2 2 0 0 0 10.4 9Z" />,
} as const;

export type ScIconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: ScIconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
