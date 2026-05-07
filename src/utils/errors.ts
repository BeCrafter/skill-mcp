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
    public readonly name: string,
    public readonly existing: Array<{ slug: string; version: string }>,
  ) {
    super(
      `Duplicate skill name "${name}". Use --id to specify which one to overwrite.\nExisting: ${existing.map(s => `${s.slug} (${s.version})`).join(", ")}`,
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

/** MCP error response helper */
export function toMcpError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
