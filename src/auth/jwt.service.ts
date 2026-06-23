import { createHmac } from "node:crypto";

export interface JwtPayload {
  sub: string;
  username?: string;
  user_type?: string;
  tags?: string[];
  type?: string;
  iss?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

// JWTs match this shape exactly: three base64url segments separated by `.`.
// Tokens that fail this regex are treated as opaque so legacy callers keep
// working — a real JWT never contains characters outside [A-Za-z0-9_-].
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE_RE.test(token);
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(
    createHmac("sha256", secret).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${signature}`;
}

export function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  secret: string,
  expectedIssuer: string,
): T {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [header, body, signature] = parts;
  const expectedSig = base64UrlEncode(
    createHmac("sha256", secret).update(`${header}.${body}`).digest(),
  );
  if (signature !== expectedSig) throw new Error("Invalid JWT signature");

  const payload = JSON.parse(base64UrlDecode(body).toString()) as T;

  if (payload.exp && payload.exp * 1000 < Date.now()) {
    throw new Error("JWT expired");
  }

  if (payload.iss !== expectedIssuer) {
    throw new Error("JWT issuer mismatch");
  }

  return payload;
}

export function signAccessToken(opts: {
  userId: string;
  username: string;
  userType: string;
  tags: string[];
  secret: string;
  expiresInSec: number;
  issuer: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: opts.userId,
    username: opts.username,
    user_type: opts.userType,
    tags: opts.tags,
    iss: opts.issuer,
    iat: now,
    exp: now + opts.expiresInSec,
  }, opts.secret);
}

export function signRefreshToken(opts: {
  userId: string;
  secret: string;
  expiresInSec: number;
  issuer: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: opts.userId,
    type: "refresh",
    iss: opts.issuer,
    iat: now,
    exp: now + opts.expiresInSec,
  }, opts.secret);
}
