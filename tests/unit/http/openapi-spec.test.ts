import { describe, it, expect } from "vitest";
import { getOpenApiSpec } from "@/http/openapi/spec.js";
import { renderSwaggerUiHtml } from "@/http/openapi/swagger-ui.js";

describe("OpenAPI spec (P0-2)", () => {
  const spec = getOpenApiSpec();

  it("uses OpenAPI 3.1 and pins /api/v1 as the canonical server", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("/api/v1");
    expect(spec.servers.find(s => s.url === "/api")?.description).toMatch(/Sunset|deprecated/i);
  });

  it("declares bearerAuth as the default global security scheme", () => {
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    const scheme = spec.components.securitySchemes.bearerAuth as { type: string; scheme: string };
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
  });

  it("exposes health probes anonymously (security: [])", () => {
    const health = spec.paths["/health"]?.get as { security?: unknown[] };
    const gwHealth = spec.paths["/gateway/health"]?.get as { security?: unknown[] };
    expect(health.security).toEqual([]);
    expect(gwHealth.security).toEqual([]);
  });

  it("documents the four lifecycle verbs from P0-9", () => {
    for (const verb of ["publish", "deprecate", "archive", "republish"]) {
      expect(spec.paths[`/admin/skills/{slug}/${verb}`]).toBeTruthy();
      expect(spec.paths[`/admin/skills/{slug}/${verb}`].post).toBeTruthy();
    }
    expect(spec.paths["/admin/skills/{slug}/lifecycle/next"]?.get).toBeTruthy();
  });

  it("documents the P0-10 async import surface (POST /import/async + jobs)", () => {
    const post = spec.paths["/admin/skills/import/async"]?.post as { responses: Record<string, unknown> };
    expect(post.responses["202"]).toBeTruthy();
    expect(spec.paths["/admin/jobs"]?.get).toBeTruthy();
    expect(spec.paths["/admin/jobs/{jobId}"]?.get).toBeTruthy();
    expect(spec.paths["/admin/jobs/{jobId}/progress"]?.get).toBeTruthy();
  });

  it("documents the P0-4 token rotation endpoint", () => {
    const rotate = spec.paths["/admin/users/{id}/tokens/rotate"]?.post as { summary: string; description: string };
    expect(rotate.summary).toMatch(/rotate/i);
    expect(rotate.description).toMatch(/grace|previous/i);
  });

  it("defines a stable Error envelope schema with a code field", () => {
    const err = spec.components.schemas.Error as { properties: { error: { properties: { code: { type: string } } } } };
    expect(err.properties.error.properties.code.type).toBe("string");
  });

  it("ImportJobView intentionally omits the options blob (secret-leak guard)", () => {
    const view = spec.components.schemas.ImportJobView as { properties: Record<string, unknown>; description?: string };
    expect(view.properties.options).toBeUndefined();
    expect(view.description).toMatch(/options.*omitted/i);
  });

  it("path refs to components/responses/NotFound resolve", () => {
    const resp = (spec.components as unknown as { responses: { NotFound: unknown } }).responses;
    expect(resp.NotFound).toBeTruthy();
  });

  it("info.version is a non-empty string", () => {
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
  });
});

describe("Swagger UI HTML (P0-2)", () => {
  it("references the spec URL passed in", () => {
    const html = renderSwaggerUiHtml("/api/v1/openapi.json");
    expect(html).toContain('"/api/v1/openapi.json"');
    expect(html).toMatch(/swagger-ui-bundle\.js/);
    expect(html).toMatch(/swagger-ui\.css/);
  });

  it("loads from a pinned-version CDN URL (not 'latest')", () => {
    const html = renderSwaggerUiHtml("/x");
    expect(html).not.toMatch(/swagger-ui-dist@latest/);
    expect(html).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+/);
  });
});
