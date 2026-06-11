CREATE TABLE `cache_global_epoch` (
  `id` text PRIMARY KEY NOT NULL,
  `epoch` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cache_user_epochs` (
  `user_id` text PRIMARY KEY NOT NULL,
  `epoch` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
