CREATE TABLE `project_embedding_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`dimensions` integer,
	`credential_source` text NOT NULL,
	`workspace_env_file` text,
	`ollama_base_url` text,
	`status` text NOT NULL,
	`active` integer NOT NULL,
	`last_error` text,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `project_embedding_configs_project_active_idx` ON `project_embedding_configs` (`project_id`,`active`);--> statement-breakpoint
CREATE INDEX `project_embedding_configs_provider_model_idx` ON `project_embedding_configs` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `trace_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`trace_document_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`dimensions` integer NOT NULL,
	`content_hash` text NOT NULL,
	`vector_json` text NOT NULL,
	`usage_json` text,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`embedded_at` text
);
--> statement-breakpoint
CREATE INDEX `trace_embeddings_project_provider_idx` ON `trace_embeddings` (`project_id`,`provider_id`,`model_id`,`dimensions`);--> statement-breakpoint
CREATE INDEX `trace_embeddings_document_idx` ON `trace_embeddings` (`trace_document_id`);--> statement-breakpoint
CREATE INDEX `trace_embeddings_status_idx` ON `trace_embeddings` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `trace_embeddings_active_content_idx` ON `trace_embeddings` (`trace_document_id`,`provider_id`,`model_id`,`dimensions`,`content_hash`);
