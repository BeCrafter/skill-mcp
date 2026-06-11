/** Base application error */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Skill not found */
export class SkillNotFoundError extends AppError {
  constructor(slug: string) {
    super(`Skill not found: ${slug}`, "SKILL_NOT_FOUND", 404);
    this.name = "SkillNotFoundError";
  }
}

/** Permission denied */
export class PermissionDeniedError extends AppError {
  constructor(slug: string) {
    super(`Permission denied for skill: ${slug}`, "PERMISSION_DENIED", 403);
    this.name = "PermissionDeniedError";
  }
}

/** Duplicate skill name */
export class DuplicateSkillNameError extends AppError {
  constructor(
    public readonly skillName: string,
    public readonly existing: Array<{ slug: string; version: string }>,
  ) {
    super(
      `Duplicate skill name "${skillName}". Use --id to specify which one to overwrite.\nExisting: ${existing.map(s => `${s.slug} (${s.version})`).join(", ")}`,
      "DUPLICATE_SKILL_NAME",
      409,
    );
    this.name = "DuplicateSkillNameError";
  }
}

/** Security violation (injection detected) */
export class SecurityError extends AppError {
  constructor(public readonly issues: string[]) {
    super(`Security violation: ${issues.join("; ")}`, "SECURITY_VIOLATION", 400);
    this.name = "SecurityError";
  }
}

/** Invalid manifest */
export class InvalidManifestError extends AppError {
  constructor(message: string) {
    super(`Invalid manifest: ${message}`, "INVALID_MANIFEST", 400);
    this.name = "InvalidManifestError";
  }
}

/** Content unchanged */
export class ContentUnchangedError extends AppError {
  constructor(name: string) {
    super(`Skill "${name}" content unchanged, no update needed`, "CONTENT_UNCHANGED", 400);
    this.name = "ContentUnchangedError";
  }
}

/** Slug already taken */
export class SlugConflictError extends AppError {
  constructor(slug: string) {
    super(`Slug "${slug}" is already in use. Choose a different slug.`, "SLUG_CONFLICT", 409);
    this.name = "SlugConflictError";
  }
}

/** Invalid file path */
export class InvalidPathError extends AppError {
  constructor(path: string) {
    super(`Invalid file path: ${path}`, "INVALID_PATH", 400);
    this.name = "InvalidPathError";
  }
}

/** Generic 400 for client-side bad request shape (handlers / CLI). */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, "BAD_REQUEST", 400);
    this.name = "BadRequestError";
  }
}

/** Specific version snapshot not found (skill exists, version doesn't). */
export class VersionNotFoundError extends AppError {
  constructor(slug: string, version: string) {
    super(`Version ${version} not found for skill ${slug}`, "VERSION_NOT_FOUND", 404);
    this.name = "VersionNotFoundError";
  }
}

/** Required dependency / repository not configured (server misconfiguration). */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR", 500);
    this.name = "ConfigurationError";
  }
}

/**
 * P1-12 stage 3 — eval regression gate refused a publish transition because
 * the latest run set for the skill's current version isn't all-pass. Carries
 * the failing and untested case names so the admin UI / CLI can render
 * actionable feedback ("run these, then retry") without re-querying.
 */
export class EvalRegressionError extends AppError {
  constructor(
    public readonly slug: string,
    public readonly version: string,
    public readonly failingCases: string[],
    public readonly untestedCases: string[],
  ) {
    const parts: string[] = [];
    if (failingCases.length > 0) parts.push(`failing: ${failingCases.join(", ")}`);
    if (untestedCases.length > 0) parts.push(`untested: ${untestedCases.join(", ")}`);
    super(
      `Eval regression gate blocked publish of "${slug}" v${version}. ${parts.join("; ")}`,
      "EVAL_REGRESSION_GATE",
      409,
    );
    this.name = "EvalRegressionError";
  }
}

/**
 * P1-14 stage 1 — OIDC JWT verification failure. The `reason` discriminator
 * lets the auth middleware emit precise audit logs without leaking token
 * material; statusCode is 401 in every case (the client sees the same response
 * shape regardless of which check failed, which avoids oracle-style probing).
 */
export type JwtVerificationReason =
  | "malformed"
  | "expired"
  | "not_yet_valid"
  | "invalid_signature"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "key_not_found"
  | "unsupported_algorithm"
  | "jwks_fetch_failed";

export class JwtVerificationError extends AppError {
  constructor(
    public readonly reason: JwtVerificationReason,
    message?: string,
  ) {
    super(message ?? `JWT verification failed: ${reason}`, "JWT_VERIFICATION_FAILED", 401);
    this.name = "JwtVerificationError";
  }
}

/**
 * Failure when calling a remote dependency (cloud service, OSS, etc.).
 * Carries the upstream HTTP status / cause so observability can dimension on it,
 * while presenting a single 502 to clients.
 */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    public readonly upstreamStatus?: number,
    public readonly cause?: unknown,
  ) {
    super(message, "UPSTREAM_ERROR", 502);
    this.name = "UpstreamError";
  }
}

/** MCP error response helper */
export function toMcpError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Translate any thrown value into an HTTP-shaped { status, body } pair.
 * Handlers should funnel `catch` blocks through this so error→status mapping
 * stays consistent across admin and gateway routes.
 */
export function mapErrorToResponse(
  error: unknown,
  fallback = "Internal error",
): { status: number; body: { success: false; error: string; code?: string } } {
  if (error instanceof AppError) {
    return { status: error.statusCode, body: { success: false, error: error.message, code: error.code } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { success: false, error: message || fallback } };
}
