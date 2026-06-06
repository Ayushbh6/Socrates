ALTER TABLE `model_usage` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `model_usage` ADD `uncached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `model_usage` ADD `cost_source` text;--> statement-breakpoint
ALTER TABLE `model_usage` ADD `pricing_snapshot_json` text;--> statement-breakpoint
CREATE TABLE `ai_usage_events` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `status` text NOT NULL,
  `started_at` text,
  `completed_at` text,
  `input_tokens` integer,
  `output_tokens` integer,
  `reasoning_tokens` integer,
  `cached_input_tokens` integer,
  `cache_write_tokens` integer,
  `uncached_input_tokens` integer,
  `total_tokens` integer,
  `cost_usd` real,
  `cost_source` text NOT NULL,
  `pricing_snapshot_json` text,
  `raw_usage_json` text,
  `metadata_json` text,
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `ai_usage_events_turn_idx` ON `ai_usage_events` (`turn_id`);--> statement-breakpoint
CREATE INDEX `ai_usage_events_conversation_idx` ON `ai_usage_events` (`conversation_id`, `created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_usage_events_source_idx` ON `ai_usage_events` (`source_kind`, `source_id`);--> statement-breakpoint
CREATE TABLE `turn_usage_reports` (
  `turn_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL,
  `status` text NOT NULL,
  `total_cost_usd` real,
  `total_tokens` integer NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  `reasoning_tokens` integer NOT NULL,
  `cached_input_tokens` integer NOT NULL,
  `cache_write_tokens` integer NOT NULL,
  `uncached_input_tokens` integer NOT NULL,
  `cost_source` text NOT NULL,
  `provider_breakdown_json` text NOT NULL,
  `model_breakdown_json` text NOT NULL,
  `call_breakdown_json` text NOT NULL,
  `compaction_breakdown_json` text NOT NULL,
  `quality_flags_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `turn_usage_reports_conversation_idx` ON `turn_usage_reports` (`conversation_id`, `updated_at`);
