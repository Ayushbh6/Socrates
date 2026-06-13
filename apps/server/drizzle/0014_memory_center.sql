ALTER TABLE `memory_agent_global_state` ADD `last_checked_at` text;
--> statement-breakpoint
ALTER TABLE `memory_agent_global_state` ADD `last_real_run_at` text;
--> statement-breakpoint
UPDATE `memory_agent_global_state`
   SET `last_checked_at` = COALESCE(`last_checked_at`, `last_run_at`),
       `last_real_run_at` = COALESCE(`last_real_run_at`, `last_run_at`);
--> statement-breakpoint
CREATE TABLE `memory_agent_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`sequence_from` integer,
	`sequence_to` integer NOT NULL,
	`turn_count` integer NOT NULL,
	`tool_calls` integer NOT NULL,
	`file_change_events` integer NOT NULL,
	`distinct_changed_files` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`checked_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `memory_agent_checks_checked_at_idx` ON `memory_agent_checks` (`checked_at`);
--> statement-breakpoint
CREATE INDEX `memory_agent_checks_status_idx` ON `memory_agent_checks` (`status`);
