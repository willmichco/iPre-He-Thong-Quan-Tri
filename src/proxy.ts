import { NextResponse, type NextRequest } from "next/server";
import { devBypassAllowed, readOwnerConfig } from "@/server/auth/config";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session-token";

/**
 * Kiểm tra lạc quan ở cửa ngõ: chưa đăng nhập → chuyển về /dang-nhap.
 * Mỗi trang / action / route handler vẫn tự kiểm tra lại qua requireOwner().
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (devBypassAllowed()) return NextResponse.next();

  const cfg = readOwnerConfig();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = cfg ? await verifySessionToken(token, cfg.sessionSecret, cfg.email) : null;
  if (claims) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Chưa đăng nhập" } }, { status: 401 });
  }
  const url = new URL("/dang-nhap", request.url);
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Bỏ qua: trang đăng nhập, kiểm tra sức khoẻ, file tĩnh, bộ giải mã wasm, biểu tượng, tệp PWA (manifest, service worker, trang mất kết nối)
    "/((?!dang-nhap|api/health|_next/static|_next/image|wasm/|ocr/|icons/|favicon.ico|nhan-mau|manifest.webmanifest|sw.js|offline.html|.*\\.(?:svg|png|jpg|webp|ico)$).*)",
  ],
};
