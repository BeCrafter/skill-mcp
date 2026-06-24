import * as jose from "jose";

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

const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE_RE.test(token);
}

function toSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  secret: string,
  expectedIssuer: string,
): Promise<T> {
  const { payload } = await jose.jwtVerify(token, toSecretKey(secret), {
    issuer: expectedIssuer,
  });
  return payload as unknown as T;
}

export async function signAccessToken(opts: {
  userId: string;
  username: string;
  userType: string;
  tags: string[];
  secret: string;
  expiresInSec: number;
  issuer: string;
}): Promise<string> {
  return new jose.SignJWT({
    username: opts.username,
    user_type: opts.userType,
    tags: opts.tags,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(opts.userId)
    .setIssuer(opts.issuer)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSec}s`)
    .sign(toSecretKey(opts.secret));
}

export async function signRefreshToken(opts: {
  userId: string;
  secret: string;
  expiresInSec: number;
  issuer: string;
}): Promise<string> {
  return new jose.SignJWT({ type: "refresh" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(opts.userId)
    .setIssuer(opts.issuer)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSec}s`)
    .sign(toSecretKey(opts.secret));
}
