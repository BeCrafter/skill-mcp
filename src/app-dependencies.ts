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
import type { SkillEvalRepository } from "./db/repositories/skill-eval.repository.js";
import type { EvalRunner } from "./eval/runner.js";
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
  evalRepo?: SkillEvalRepository;
  evalRunner?: EvalRunner;
  pipelineRunStore?: PipelineRunStore;
  importJobRepo?: ImportJobRepository;
  importWorker?: BackgroundImportWorker;
  usageEventRepo?: UsageEventRepository;
  usageMeter?: UsageMeterService;
  tenantQuotaRepo?: TenantQuotaRepository;
  quotaService?: QuotaService;
  webhookRepo?: WebhookRepository;
  webhookDeliveryRepo?: WebhookDeliveryRepository;
  webhookService?: WebhookService;
  webhookWorker?: WebhookWorker;
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAccessExpiresIn?: number;
  jwtRefreshExpiresIn?: number;
}

export interface TransportConfig {
  type: "sse" | "http";
}
