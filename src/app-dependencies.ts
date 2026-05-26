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
}

export interface TransportConfig {
  type: "sse" | "http";
}
