/**
 * Phiên đăng nhập = JWT ký HS256 trong cookie HttpOnly.
 * File này không dùng API riêng của Next để chạy được cả trong proxy.ts lẫn kiểm thử.
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ipre_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 giờ

export interface SessionClaims {
  sub: string; // email chủ
  iat: number;
  exp: number;
}

function key(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(email: string, secret: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(email)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .setIssuer("ipre")
    .setAudience("ipre-dashboard")
    .sign(key(secret));
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  expectedEmail: string,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: "ipre",
      audience: "ipre-dashboard",
    });
    if (payload.sub !== expectedEmail) return null;
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}
