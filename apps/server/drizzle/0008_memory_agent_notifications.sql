CREATE TABLE `memory_agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`fallback_model_ids_json` text,
	`evidence_turn_ids_json` text NOT NULL,
	`evidence_tokens_estimate` integer NOT NULL,
	`output_json` text,
	`error_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `memory_agent_jobs_project_status_idx` ON `memory_agent_jobs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `memory_agent_jobs_turn_idx` ON `memory_agent_jobs` (`turn_id`);--> statement-breakpoint
CREATE TABLE `memory_agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`turn_id` text,
	`target_kind` text NOT NULL,
	`target_path` text NOT NULL,
	`status` text NOT NULL,
	`requires_confirmation` integer NOT NULL,
	`confirmation_id` text,
	`before_hash` text,
	`after_hash` text,
	`patch_json` text NOT NULL,
	`rationale` text,
	`error` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `memory_agent_actions_job_idx` ON `memory_agent_actions` (`job_id`);--> statement-breakpoint
CREATE INDEX `memory_agent_actions_target_idx` ON `memory_agent_actions` (`target_kind`,`status`);--> statement-breakpoint
CREATE TABLE `memory_agent_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`action_id` text NOT NULL,
	`project_id` text NOT NULL,
	`document` text NOT NULL,
	`prompt_text` text NOT NULL,
	`response_text` text,
	`decision` text,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `memory_agent_confirmations_job_idx` ON `memory_agent_confirmations` (`job_id`);--> statement-breakpoint
CREATE INDEX `memory_agent_confirmations_action_idx` ON `memory_agent_confirmations` (`action_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`turn_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`severity` text NOT NULL,
	`payload_json` text,
	`read_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_project_read_idx` ON `notifications` (`project_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);
