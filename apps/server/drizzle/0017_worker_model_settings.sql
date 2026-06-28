CREATE TABLE `worker_model_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `thinking_enabled` integer NOT NULL,
  `thinking_effort` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_model_settings_worker_idx` ON `worker_model_settings` (`worker_id`);
