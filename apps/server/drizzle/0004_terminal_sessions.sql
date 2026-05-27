CREATE TABLE `terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`platform` text,
	`shell_kind` text,
	`shell_executable` text,
	`process_id` text,
	`exit_code` integer,
	`signal` text,
	`auto_detached` integer NOT NULL,
	`awaiting_input` integer NOT NULL,
	`last_prompt` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_conversation_idx` ON `terminal_sessions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_status_idx` ON `terminal_sessions` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_process_idx` ON `terminal_sessions` (`process_id`);--> statement-breakpoint
CREATE TABLE `terminal_output_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`terminal_session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`stream` text NOT NULL,
	`text` text NOT NULL,
	`redacted` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `terminal_output_chunks_session_sequence_idx` ON `terminal_output_chunks` (`terminal_session_id`,`sequence`);
