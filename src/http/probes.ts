import type { SkillRepository } from "../db/repositories/skill.repository.js";

/**
 * P0-7 — Liveness vs readiness split for k8s deployments.
 *
 * - **Liveness** (`/api/v1/livez`): "is this process alive?" — answer 200 as
 *   long as the event loop is responsive. No I/O, no DB calls. The kubelet
 *   uses this to decide whether to *restart* the pod.
 * - **Readiness** (`/api/v1/readyz`): "should this pod receive traffic?" —
 *   answer 200 only after dependencies (DB, cache) are reachable. The kubelet
 *   uses this to gate Service endpoint inclusion. A failing readiness probe
 *   removes the pod from the load balancer rotation but does NOT restart it.
 *
 * Why split? The previous `/api/health` returned 200 from process start, so
 * traffic could land on a pod whose DB connection had not finished opening
 * (T-302 race). With readyz, k8s sees 503 until `skillRepo.count()` succeeds.
 *
 * Why a single cheap query for readiness? A `SELECT count(*) FROM skills`
 * round-trip exercises the SQLite better-sqlite3 connection without touching
 * external state. <1ms in normal operation; if the DB file is missing or the
 * WAL is locked, it fails fast and we report `not ready` rather than 200ing
 * with a half-initialized stack.
 */
export interface ProbeResult {
  status: "ok" | "not_ready";
  checks: {
    db: { ok: boolean; latencyMs: number; error?: string };
  };
}

export interface ReadinessDeps {
  skillRepo?: SkillRepository;
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ProbeResult> {
  const dbStart = Date.now();
  let dbOk = false;
  let dbErr: string | undefined;
  try {
    if (!deps.skillRepo) {
      // Cloud-only nodes may not have a SkillRepository wired (rare). If we
      // didn't get one, treat the readiness check as "process is up but the
      // probe has no DB to verify" — fail closed so k8s won't route traffic
      // before the operator has reviewed the deployment.
      dbErr = "skillRepo not configured";
    } else {
      // count() is the cheapest DB round-trip; it touches no user data and
      // works on an empty schema. better-sqlite3 throws synchronously on
      // connection failure so we don't need a timeout wrapper.
      deps.skillRepo.count();
      dbOk = true;
    }
  } catch (err) {
    dbErr = err instanceof Error ? err.message : String(err);
  }
  const dbLatency = Date.now() - dbStart;

  const status: ProbeResult["status"] = dbOk ? "ok" : "not_ready";
  return {
    status,
    checks: {
      db: dbOk ? { ok: true, latencyMs: dbLatency } : { ok: false, latencyMs: dbLatency, error: dbErr },
    },
  };
}

/**
 * Liveness payload: stable shape `{ status: "ok", timestamp }` so legacy
 * `/api/health` callers (and existing test fixtures) keep working unchanged
 * — the probe is renamed (`/livez` is the new canonical) but the response
 * contract is preserved.
 */
export function checkLiveness(): { status: "ok"; timestamp: string } {
  return { status: "ok", timestamp: new Date().toISOString() };
}
