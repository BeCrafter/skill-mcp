import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, parsePagination, requireSlug, readJsonBody, requireFilePaths } from "../../helpers.js";
import { BadRequestError, DuplicateSkillNameError } from "../../../utils/errors.js";
import { toSkillMetaPublic, type SkillStatus } from "../../../types/index.js";

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let pos = 0;
  while (pos < body.length) {
    // Find next boundary
    const boundaryStart = body.indexOf(delimiter, pos);
    if (boundaryStart === -1) break;

    // Check if it's the end delimiter
    const afterBoundary = body.indexOf("\r\n", boundaryStart);
    if (afterBoundary === -1) break;

    const boundaryContent = body.slice(boundaryStart, afterBoundary).toString();
    if (boundaryContent.trim() === `--${boundary}--`) break;

    // Find headers end (double CRLF)
    const headersEnd = body.indexOf("\r\n\r\n", afterBoundary);
    if (headersEnd === -1) break;

    const headersStr = body.slice(afterBoundary + 2, headersEnd).toString();
    const nameMatch = headersStr.match(/name="([^"]+)"/);
    const filenameMatch = headersStr.match(/filename="([^"]+)"/);
    const ctMatch = headersStr.match(/Content-Type:\s*(.+)/i);

    // Find next boundary for data end
    const nextBoundary = body.indexOf(delimiter, headersEnd + 4);
    const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length; // -2 for \r\n before boundary

    const data = body.slice(headersEnd + 4, dataEnd);

    parts.push({
      name: nameMatch?.[1] ?? "",
      filename: filenameMatch?.[1],
      contentType: ctMatch?.[1]?.trim(),
      data,
    });

    pos = nextBoundary !== -1 ? nextBoundary : body.length;
  }

  return parts;
}

// P0-9 — published lifecycle transitions exposed at the HTTP layer. Each verb
// names its target state explicitly (rather than a generic PATCH ?status=…)
// so audit logs and API gateways can authorize by route alone.
const LIFECYCLE_VERBS: Record<string, SkillStatus> = {
  publish: "published",
  deprecate: "deprecated",
  archive: "archived",
  republish: "published",
};

/**
 * Admin skill routes — handlers throw domain errors (BadRequestError,
 * SkillNotFoundError, …) which the router-level `errorMap` middleware
 * translates into HTTP responses. No try/catch in the happy path.
 *
 * P0-A — every route delegates to `skillService.admin*`; cache invalidation,
 * event publication, body allowlisting, and storage cleanup are owned by the
 * service layer (review §4.1). This handler is a thin parameter-extraction
 * shim — repos/storage/importer/eventBus are deliberately not destructured.
 */
export function registerAdminSkillRoutes(router: Router, deps: AppDependencies): void {
  const { skillService } = deps;

  router.get("/api/admin/skills", async (ctx) => {
    const category = ctx.query.get("category") ?? undefined;
    const tags = ctx.query.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(ctx.query);

    const attributes: Record<string, string> = {};
    for (const [key, value] of ctx.query) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    const skills = await skillService.adminListSkills({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    const paginated = skills.slice(offset, offset + limit);
    json(ctx.res, 200, { success: true, data: paginated, total: skills.length, offset, limit });
  });

  router.get("/api/admin/skills/effectiveness-report", async (ctx) => {
    const days = parseInt(ctx.query.get("days") ?? "30", 10);
    const rates = await skillService.getEffectivenessRates(days);
    const report = [];
    for (const [slug, { rate, count }] of rates) {
      let recommendation: string;
      if (rate >= 0.8) recommendation = "Performing well";
      else if (rate >= 0.5) recommendation = "Needs attention";
      else if (count >= 10) recommendation = "Consider deprecating or rewriting";
      else recommendation = "Insufficient data, continue monitoring";
      report.push({ slug, effectiveness: Math.round(rate * 100) / 100, feedback_count: count, recommendation });
    }
    json(ctx.res, 200, { success: true, data: { report, generated_at: new Date().toISOString() } });
  });

  router.get("/api/admin/skills/name/:name", async (ctx) => {
    const name = ctx.params.name;
    const skills = await skillService.adminFindSkillsByName(name);
    json(ctx.res, 200, { success: true, data: skills, total: skills.length });
  });

  router.get("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const skill = await skillService.adminGetSkillBySlug(slug);
    json(ctx.res, 200, { success: true, data: skill });
  });

  router.put("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<Record<string, unknown>>(ctx.req);
    const updated = await skillService.adminUpdateSkill(slug, data);
    json(ctx.res, 200, { success: true, data: updated });
  });

  // P1-11 stage 2b — manual retrieval-signal tuning. Lets ops adjust
  // triggers / when_to_use / embedding_text without re-importing the
  // package; the BM25 indexer picks up the new text via the skill:updated
  // event handler. Body shape mirrors `SkillRetrievalMeta` (camelCase or
  // snake_case both accepted); send `null` to clear all three fields.
  router.put("/api/admin/skills/:slug/retrieval", async (ctx) => {
    const slug = requireSlug(ctx);
    const raw = await readJsonBody<Record<string, unknown> | null>(ctx.req);
    const normalised = raw === null ? null : {
      ...(raw.triggers !== undefined ? { triggers: raw.triggers as string[] | undefined } : {}),
      ...(raw.when_to_use !== undefined ? { whenToUse: raw.when_to_use as string | undefined } : {}),
      ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string | undefined } : {}),
      ...(raw.embedding_text !== undefined ? { embeddingText: raw.embedding_text as string | undefined } : {}),
      ...(raw.embeddingText !== undefined ? { embeddingText: raw.embeddingText as string | undefined } : {}),
    };
    const updated = await skillService.adminUpdateRetrievalMeta(slug, normalised);
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    await skillService.adminDeleteSkill(slug);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/skills/:slug/entry", async (ctx) => {
    const slug = requireSlug(ctx);
    const content = await skillService.adminGetEntry(slug);
    ctx.res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    ctx.res.end(content);
  });

  router.post("/api/admin/skills/:slug/files", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ paths?: unknown }>(ctx.req);
    const paths = requireFilePaths(data.paths);
    const files = await skillService.adminGetFiles(slug, paths);
    json(ctx.res, 200, { success: true, data: files });
  });

  router.get("/api/admin/skills/:slug/file-tree", async (ctx) => {
    const slug = requireSlug(ctx);
    const tree = await skillService.adminGetFileTree(slug);
    json(ctx.res, 200, { success: true, data: tree });
  });

  router.post("/api/admin/skills", async (ctx) => {
    const contentType = ctx.req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      throw new BadRequestError("ZIP upload not yet supported, use CLI import or JSON body with source path");
    }
    const data = await readJsonBody<{
      source?: string;
      category?: string;
      tags?: string[];
      description?: string;
      target_id?: string;
      version_bump?: "major" | "minor" | "patch";
      overwrite?: boolean;
      allow_duplicate?: boolean;
      slug?: string;
      branch?: string;
      sub_dir?: string;
    }>(ctx.req);
    if (!data.source) throw new BadRequestError("source is required");
    const result = await skillService.adminImportSkill(data.source, {
      category: data.category,
      tags: data.tags,
      description: data.description,
      targetId: data.target_id,
      versionBump: data.version_bump ?? "patch",
      overwrite: data.overwrite ?? false,
      allowDuplicate: data.allow_duplicate ?? false,
      slug: data.slug,
      branch: data.branch,
      subDir: data.sub_dir,
    });
    json(ctx.res, 201, { success: true, data: result });
  });

  router.get("/api/admin/logs", async (ctx) => {
    const skillSlug = ctx.query.get("skill_slug") ?? "";
    const limit = Math.min(200, Math.max(1, parseInt(ctx.query.get("limit") ?? "50", 10)));
    if (!skillSlug) throw new BadRequestError("skill_slug query parameter is required");
    const logs = await skillService.adminFindAccessLogs(skillSlug, limit);
    json(ctx.res, 200, { success: true, data: logs, total: logs.length });
  });

  router.get("/api/admin/stats", async (ctx) => {
    const total = await skillService.adminCountSkills();
    json(ctx.res, 200, { success: true, data: { totalSkills: total } });
  });

  router.get("/api/admin/skills/:slug/versions", async (ctx) => {
    const slug = requireSlug(ctx);
    const limit = parseInt(ctx.query.get("limit") ?? "10", 10);
    const versions = await skillService.getVersions(slug, limit);
    json(ctx.res, 200, { success: true, data: versions });
  });

  router.get("/api/admin/skills/:slug/versions/diff", async (ctx) => {
    const slug = requireSlug(ctx);
    const v1 = ctx.query.get("v1");
    const v2 = ctx.query.get("v2");
    if (!v1 || !v2) throw new BadRequestError("v1 and v2 query params required");
    const diff = await skillService.getVersionDiff(slug, v1, v2);
    json(ctx.res, 200, { success: true, data: diff });
  });

  router.get("/api/admin/skills/:slug/lifecycle/next", async (ctx) => {
    const slug = requireSlug(ctx);
    const result = await skillService.getNextLifecycleStates(slug);
    json(ctx.res, 200, { success: true, data: result });
  });

  for (const [verb, target] of Object.entries(LIFECYCLE_VERBS)) {
    router.post(`/api/admin/skills/:slug/${verb}`, async (ctx) => {
      const slug = requireSlug(ctx);
      const updated = await skillService.adminTransitionLifecycle(slug, target);
      json(ctx.res, 200, { success: true, data: toSkillMetaPublic(updated) });
    });
  }

  router.post("/api/admin/skills/:slug/rollback", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ version?: string }>(ctx.req);
    if (!data.version) throw new BadRequestError("version is required");
    await skillService.adminRollbackToVersion(slug, data.version);
    json(ctx.res, 200, { success: true, message: `Rolled back to version ${data.version}` });
  });

  // ── Skill upload endpoint (for remote CLI import) ──────────────

  router.post("/api/admin/skills/upload", async (ctx) => {
    // Parse multipart/form-data to extract file and metadata
    const contentType = ctx.req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new BadRequestError("Expected multipart/form-data");
    }

    // Read raw body
    const chunks: Buffer[] = [];
    for await (const chunk of ctx.req) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);

    // Extract boundary
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) throw new BadRequestError("Missing multipart boundary");
    const boundary = boundaryMatch[1];

    // Parse multipart parts (simple parser)
    const parts = parseMultipart(rawBody, boundary);
    const filePart = parts.find(p => p.name === "file");
    const metadataPart = parts.find(p => p.name === "metadata");

    if (!filePart) throw new BadRequestError("Missing 'file' field");
    if (!metadataPart) throw new BadRequestError("Missing 'metadata' field");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let metadata: any;
    try {
      metadata = JSON.parse(metadataPart.data.toString("utf-8"));
    } catch {
      throw new BadRequestError("metadata is not valid JSON");
    }

    // Extract to temp directory and import
    const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execSync } = await import("node:child_process");

    const tmpDir = mkdtempSync(join(tmpdir(), "skill-upload-"));
    const tarPath = join(tmpDir, "upload.tar.gz");

    try {
      writeFileSync(tarPath, filePart.data);
      const extractDir = join(tmpDir, "extracted");
      mkdirSync(extractDir, { recursive: true });
      execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: "pipe" });

      const importer = deps.importer;
      if (!importer) throw new BadRequestError("Importer not configured");

      const result = await importer.import(extractDir, {
        category: metadata.category,
        tags: metadata.tags,
        description: metadata.description,
        targetId: metadata.target_id,
        versionBump: metadata.version_bump,
        overwrite: metadata.overwrite,
        allowDuplicate: metadata.allow_duplicate,
        slug: metadata.slug,
      });

      json(ctx.res, 201, { success: true, data: result });
    } catch (error) {
      if (error instanceof DuplicateSkillNameError) {
        json(ctx.res, 409, { success: false, error: error.message, code: error.code });
      } else {
        throw error;
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}
