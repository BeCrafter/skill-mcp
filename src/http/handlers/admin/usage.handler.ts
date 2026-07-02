import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json } from "../../helpers.js";
import { BadRequestError, ConfigurationError } from "../../../utils/errors.js";
import type { AggregateRow } from "../../../db/repositories/usage-event.repository.js";

// P1-13 — Admin usage metering endpoints (review §9.1).
//
// Surface:
//   GET /api/admin/usage/aggregate?fromBucket=&toBucket=&eventType=&format=json|csv
//   GET /api/admin/usage/events?fromBucket=&toBucket=&eventType=&limit=
//
// CSV export is opt-in via `?format=csv`; default JSON keeps the response
// shape consistent with the rest of the admin surface.

const HOUR_BUCKET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const VALID_EVENT_TYPES = new Set(["skill.view", "pipeline.run", "api.call", "storage.write"]);
const MAX_LIST_LIMIT = 10000;

function validateBucket(name: string, value: string | null): string | undefined {
  if (!value) return undefined;
  if (!HOUR_BUCKET_RE.test(value)) {
    throw new BadRequestError(`${name} must match YYYY-MM-DDTHH (e.g. 2026-05-28T13)`);
  }
  return value;
}

function validateEventType(value: string | null): string | undefined {
  if (!value) return undefined;
  // Free-form by design (see repository docs), but the four canonical types
  // get an explicit nudge so a typo like `skill.views` returns 400 instead
  // of an empty result set that looks like "no usage."
  if (!VALID_EVENT_TYPES.has(value) && !/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(value)) {
    throw new BadRequestError(`eventType "${value}" is not in the allow-list and does not match \`<domain>.<name>\``);
  }
  return value;
}

function rowsToCsv(rows: AggregateRow[]): string {
  const header = "event_type,hour_bucket,total_quantity,event_count\n";
  const body = rows
    .map(r => `${r.eventType},${r.hourBucket},${r.totalQuantity},${r.eventCount}`)
    .join("\n");
  return header + (body ? body + "\n" : "");
}


export function registerAdminUsageRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.usageMeter) return;
  const { usageMeter } = deps;
  router.get("/api/admin/usage/aggregate", async (ctx) => {
    const fromBucket = validateBucket("fromBucket", ctx.query.get("fromBucket"));
    const toBucket = validateBucket("toBucket", ctx.query.get("toBucket"));
    const eventType = validateEventType(ctx.query.get("eventType"));
    const format = ctx.query.get("format") ?? "json";

    const rows = usageMeter.aggregate({ fromBucket, toBucket, eventType });

    if (format === "csv") {
      const csv = rowsToCsv(rows);
      ctx.res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": Buffer.byteLength(csv),
        "Content-Disposition": `attachment; filename="usage.csv"`,
      });
      ctx.res.end(csv);
      return;
    }
    if (format !== "json") {
      throw new BadRequestError(`format must be "json" or "csv" (got "${format}")`);
    }

    json(ctx.res, 200, {
      success: true,
      data: rows.map(r => ({
        event_type: r.eventType,
        hour_bucket: r.hourBucket,
        total_quantity: r.totalQuantity,
        event_count: r.eventCount,
      })),
      total: rows.length,
    });
  });
  router.get("/api/admin/usage/events", async (ctx) => {
    if (!deps.usageEventRepo) {
      throw new ConfigurationError("usageEventRepo not configured");
    }
    const fromBucket = validateBucket("fromBucket", ctx.query.get("fromBucket"));
    const toBucket = validateBucket("toBucket", ctx.query.get("toBucket"));
    const eventType = validateEventType(ctx.query.get("eventType"));
    const limitRaw = ctx.query.get("limit");
    let limit = 1000;
    if (limitRaw) {
      const n = parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_LIST_LIMIT) {
        throw new BadRequestError(`limit must be a positive integer ≤ ${MAX_LIST_LIMIT}`);
      }
      limit = n;
    }

    const events = usageMeter.list({ fromBucket, toBucket, eventType, limit });
    json(ctx.res, 200, {
      success: true,
      data: events.map(e => ({
        id: e.id,
        user_id: e.userId,
        event_type: e.eventType,
        resource_id: e.resourceId,
        quantity: e.quantity,
        metadata: e.metadata,
        hour_bucket: e.hourBucket,
        created_at: e.createdAt,
      })),
      total: events.length,
    });
  });
}
