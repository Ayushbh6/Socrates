CREATE TABLE `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`note_number` integer NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`intent` text NOT NULL,
	`note` text NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`message_id` text,
	`message_excerpt` text,
	`created_by_agent` text NOT NULL,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `memory_notes_status_idx` ON `memory_notes` (`status`,`note_number`);--> statement-breakpoint
CREATE INDEX `memory_notes_source_turn_idx` ON `memory_notes` (`turn_id`);--> statement-breakpoint
CREATE INDEX `memory_notes_conversation_idx` ON `memory_notes` (`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_notes_number_idx` ON `memory_notes` (`note_number`);--> statement-breakpoint
CREATE TABLE `skill_writer_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`operation` text NOT NULL,
	`skill_name` text NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`source_kind` text NOT NULL,
	`source_id` text,
	`status` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`output_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `skill_writer_jobs_status_idx` ON `skill_writer_jobs` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `skill_writer_jobs_source_idx` ON `skill_writer_jobs` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `skill_writer_jobs_skill_idx` ON `skill_writer_jobs` (`scope`,`skill_name`);
