CREATE TABLE `memory_agent_global_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`thinking_enabled` integer NOT NULL,
	`thinking_effort` text,
	`enabled` integer NOT NULL,
	`cadence_minutes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `memory_agent_global_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_processed_event_sequence` integer NOT NULL,
	`last_run_at` text,
	`status` text NOT NULL,
	`active_job_id` text,
	`last_job_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
