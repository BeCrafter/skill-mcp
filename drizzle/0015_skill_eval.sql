-- P1-12 (stage 2) — Persist skill eval cases + run log.
--
-- Stage 1 (already shipped) introduced the `eval_cases:` SKILL.md frontmatter
-- field and validated it at import time. Stage 2 is the persistence + minimal
-- runner: every imported case lands in `skill_eval_cases`, and every run by
-- `skill-mcp eval run <slug>` appends to `skill_eval_runs` so stage 3's
-- version-bump regression gate has a queryable history to assert against.
--
-- Schema choices:
--   * Cases table is keyed by (skill_id, case_name) UNIQUE because stage 1
--     already enforces uniqueness within a skill — the DB constraint exists
--     so re-imports can safely upsert and so a parallel writer cannot
--     introduce duplicates.
--   * `expectations_json` is a single JSON envelope (rather than three columns)
--     so future expectation kinds (`expected_latency_ms`, `expected_score_min`,
--     `expected_tool_order`) ship without a migration — the runner reads the
--     envelope and ignores keys it doesn't know.
--   * Runs table is append-only: one row per (case × invocation), keyed by
--     (skill_id, skill_version) for stage 3's regression-pass query and by
--     (created_at) for the CLI's "last 20 runs" list. A run that errored
--     before producing a result row gets `status='error'` so the regression
--     gate can distinguish "ran and was wrong" from "couldn't run".
--   * `runner` text is left flexible (not an enum) so swapping in real LLM
--     providers in stage 3 doesn't require a column type change.
CREATE TABLE `skill_eval_cases` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text DEFAULT 'default' NOT NULL,
  `skill_id` text NOT NULL,
  `case_name` text NOT NULL,
  `input` text NOT NULL,
  `expectations_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_skill_eval_cases_skill_case` ON `skill_eval_cases` (`skill_id`, `case_name`);
--> statement-breakpoint
CREATE INDEX `idx_skill_eval_cases_skill_id` ON `skill_eval_cases` (`skill_id`);
--> statement-breakpoint
CREATE TABLE `skill_eval_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text DEFAULT 'default' NOT NULL,
  `skill_id` text NOT NULL,
  `skill_version` text NOT NULL,
  `case_name` text NOT NULL,
  `status` text NOT NULL,
  `runner` text DEFAULT 'stub' NOT NULL,
  `tools_used_json` text,
  `output` text,
  `failure_reason` text,
  `latency_ms` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_skill_eval_runs_skill_version` ON `skill_eval_runs` (`skill_id`, `skill_version`);
--> statement-breakpoint
CREATE INDEX `idx_skill_eval_runs_created_at` ON `skill_eval_runs` (`created_at`);
