// ============================================================
// Skill MCP Server — Core Type Definitions
// ============================================================

/** Skill status lifecycle */
export type SkillStatus = "draft" | "published" | "deprecated" | "archived";

/** Skill visibility */
export type SkillVisibility = "public" | "private" | "internal";

/** Version bump type */
export type VersionBump = "major" | "minor" | "patch";

/** File encoding */
export type FileEncoding = "utf-8" | "base64";

/** Skill metadata (DB entity) */
export interface SkillMeta {
  id: string;
  slug: string;
  name: string;
  displayName: string | null;
  description: string;
  version: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  status: SkillStatus;
  visibility: SkillVisibility;
  entryFile: string;
  storagePath: string;
  contentHash: string | null;
  conditions: Record<string, unknown> | null;
  assignedGroups: string[];
  createdAt: number;
  updatedAt: number;
}

/** Skill metadata input (for create/update) */
export type SkillMetaInput = Partial<Omit<SkillMeta, "id" | "createdAt" | "updatedAt">> &
  Pick<SkillMeta, "slug" | "name">;

/** File info in skill file tree */
export interface FileInfo {
  path: string;
  type: "file" | "directory";
  size: number;
  mimeType: string;
}

/** Skill file content */
export interface SkillFileContent {
  path: string;
  content: string;
  encoding: FileEncoding;
  mimeType?: string;
}

/** Skill package file input (for import) */
export interface SkillFileInput {
  path: string;
  buffer: Buffer;
}

/** Manifest.json structure */
export interface SkillManifest {
  name: string;
  version?: string;
  entry?: string;
  files?: string[];
}

/** Import options */
export interface ImportOptions {
  category?: string;
  tags?: string[];
  description?: string;
  targetId?: string;
  versionBump?: VersionBump;
  overwrite?: boolean;
  branch?: string;
  subDir?: string;
}

/** Import result */
export interface ImportResult {
  id: string;
  slug: string;
  name: string;
  version: string;
  fileCount: number;
  category?: string;
  tags?: string[];
  action: "created" | "updated";
}

/** Access log entry */
export interface AccessLogEntry {
  id: string;
  skillId: string;
  skillSlug: string;
  action: "list" | "view_entry" | "read_files";
  filePaths?: string[];
  latencyMs?: number;
  createdAt: number;
}

/** Transport type */
export type TransportType = "stdio" | "sse" | "http";

/** Deployment mode */
export type DeploymentMode = "standalone" | "gateway";

/** Storage type */
export type StorageType = "local-fs" | "aliyun-oss";
