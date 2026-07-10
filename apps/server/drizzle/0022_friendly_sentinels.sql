CREATE TABLE `memory_agent_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`summary` text NOT NULL,
	`patterns_observed_json` text NOT NULL,
	`skills_affected_json` text NOT NULL,
	`decisions_json` text NOT NULL,
	`open_investigations_json` text NOT NULL,
	`next_run_focus_json` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`thinking_enabled` integer NOT NULL,
	`thinking_effort` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_agent_journal_job_idx` ON `memory_agent_journal` (`job_id`);--> statement-breakpoint
CREATE INDEX `memory_agent_journal_created_at_idx` ON `memory_agent_journal` (`created_at`);