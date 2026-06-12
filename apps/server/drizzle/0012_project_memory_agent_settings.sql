CREATE TABLE `project_memory_agent_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`thinking_enabled` integer NOT NULL,
	`thinking_effort` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_memory_agent_settings_project_idx` ON `project_memory_agent_settings` (`project_id`);
