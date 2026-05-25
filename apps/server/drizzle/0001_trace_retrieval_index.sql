CREATE TABLE `trace_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text,
	`turn_id` text,
	`source_kind` text NOT NULL,
	`source_table` text NOT NULL,
	`source_id` text NOT NULL,
	`handle` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`importance` text,
	`preserve_verbatim` integer NOT NULL,
	`chunk_index` integer,
	`token_count_estimate` integer,
	`metadata_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trace_documents_project_created_idx` ON `trace_documents` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `trace_documents_conversation_created_idx` ON `trace_documents` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `trace_documents_turn_idx` ON `trace_documents` (`turn_id`);--> statement-breakpoint
CREATE INDEX `trace_documents_source_idx` ON `trace_documents` (`source_table`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trace_documents_handle_idx` ON `trace_documents` (`handle`);--> statement-breakpoint
CREATE INDEX `trace_documents_kind_idx` ON `trace_documents` (`source_kind`);--> statement-breakpoint
CREATE VIRTUAL TABLE `trace_documents_fts` USING fts5(
	`trace_document_id` UNINDEXED,
	`title`,
	`summary`,
	`content`,
	`metadata_text`
);
--> statement-breakpoint
CREATE TABLE `trace_index_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text,
	`turn_id` text,
	`job_kind` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`error_id` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `trace_index_jobs_project_status_idx` ON `trace_index_jobs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `trace_index_jobs_turn_idx` ON `trace_index_jobs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `trace_index_jobs_kind_status_idx` ON `trace_index_jobs` (`job_kind`,`status`);
