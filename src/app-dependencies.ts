import type { SkillService } from "./services/skill.service.js";
import type { ISkillProvider } from "./provider/interface.js";
import type { SkillRepository } from "./db/repositories/skill.repository.js";
import type { SkillFileRepository } from "./db/repositories/skill-file.repository.js";
import type { AccessLogRepository } from "./db/repositories/access-log.repository.js";
import type { UserRepository } from "./db/repositories/user.repository.js";
import type { RoleRepository } from "./db/repositories/role.repository.js";
import type { UserRoleRepository } from "./db/repositories/user-role.repository.js";
import type { SkillFeedbackRepository } from "./db/repositories/skill-feedback.repository.js";
import type { IStorageProvider } from "./storage/provider.interface.js";
import type { ICacheProvider } from "./cache/provider.interface.js";
import type { SkillImporter } from "./import/importer.js";
import type { DomainEventBus } from "./events/event-bus.js";
import type { CacheEpochManager } from "./cache/cache-epochs.js";
import type { PipelineRunStore } from "./pipeline/run-store.js";
import type { ImportJobRepository } from "./db/repositories/import-job.repository.js";
import type { BackgroundImportWorker } from "./services/import-worker.js";
import type { UsageEventRepository } from "./db/repositories/usage-event.repository.js";
import type { UsageMeterService } from "./services/usage-meter.service.js";
import type { TenantQuotaRepository } from "./db/repositories/tenant-quota.repository.js";
import type { QuotaService } from "./services/quota.service.js";
import type { WebhookRepository } from "./db/repositories/webhook.repository.js";
import type { WebhookDeliveryRepository } from "./db/repositories/webhook-delivery.repository.js";
import type { WebhookService } from "./services/webhook.service.js";
import type { WebhookWorker } from "./services/webhook-worker.js";
import type { OidcContextOptions } from "./permission/context-builder.js";
import type { OidcIdentityRepository } from "./db/repositories/oidc-identity.repository.js";
import type { OidcGroupRoleMapRepository } from "./db/repositories/oidc-group-role-map.repository.js";
import type { OidcProvisioner } from "./auth/oidc-provisioner.js";

export interface AppDependencies {
  skillService: SkillService;
  skillProvider: ISkillProvider;
  serverName: string;
  serverVersion: string;
  skillRepo: SkillRepository;
  skillFileRepo: SkillFileRepository;
  accessLogRepo: AccessLogRepository;
  storage: IStorageProvider;
  cache: ICacheProvider;
  importer: SkillImporter;
  eventBus: DomainEventBus;
  cacheEpochs: CacheEpochManager;
  userRepo?: UserRepository;
  roleRepo?: RoleRepository;
  userRoleRepo?: UserRoleRepository;
  feedbackRepo?: SkillFeedbackRepository;
  pipelineRunStore?: PipelineRunStore;
  importJobRepo?: ImportJobRepository;
  importWorker?: BackgroundImportWorker;
  // P1-13 — usage metering. Optional so existing callers (CLI tests, tools
  // that don't run a server) can keep their slim mocks. When unset, hot-path
  // wiring is a no-op; aggregate / list / retention helpers raise
  // ConfigurationError at the admin handler.
  usageEventRepo?: UsageEventRepository;
  usageMeter?: UsageMeterService;
  // P1-13.5 — tier limits + per-field overrides. Optional for the same
  // reason as `usageMeter`: tests / minimal CLI invocations don't need
  // quota enforcement. When unset, the quota middleware is not registered
  // and the admin /quotas endpoints respond 500 ConfigurationError.
  tenantQuotaRepo?: TenantQuotaRepository;
  quotaService?: QuotaService;
  // P1-16 — Outbound webhooks. Optional so unit tests / CLI commands can keep
  // their slim DI bag. When unset, webhook admin routes are not registered and
  // domain events that would have triggered fan-out simply pass through.
  webhookRepo?: WebhookRepository;
  webhookDeliveryRepo?: WebhookDeliveryRepository;
  webhookService?: WebhookService;
  webhookWorker?: WebhookWorker;
  // P1-14 stage 2 — optional OIDC verifier wiring. When config.auth.oidc is
  // set, serve-cmd builds an `OidcVerifier` + `RemoteJwksProvider` pair and
  // passes it through here so admin/gateway middlewares + the MCP context
  // builder all share the same instance (single JWKS cache, single audit
  // surface). Absent when SSO is disabled — middlewares fall through to
  // opaque-token auth unchanged.
  oidc?: OidcContextOptions;
  // P1-14 stage 3 — auto-provisioning + group→role mapping. Repositories
  // back the admin REST surface; the provisioner is wired through `oidc`
  // so the context builder can swap synthetic `oidc:<iss>:<sub>` userIds
  // for real user rows on first sight. All optional for parity with stage
  // 2 — absent fields collapse back to stage-2 synthetic identities.
  oidcIdentityRepo?: OidcIdentityRepository;
  oidcGroupRoleMapRepo?: OidcGroupRoleMapRepository;
  oidcProvisioner?: OidcProvisioner;
}

export interface TransportConfig {
  type: "sse" | "http";
}
