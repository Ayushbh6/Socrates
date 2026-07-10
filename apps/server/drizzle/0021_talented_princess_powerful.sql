ALTER TABLE `memory_doc_sections` ADD `content` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `retrieval_index_states` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `index_version` integer NOT NULL,
  `table_name` text,
  `status` text NOT NULL,
  `embedding_fingerprint` text,
  `lexical_ready` integer NOT NULL,
  `vector_ready` integer NOT NULL,
  `trace_parents` integer NOT NULL,
  `trace_chunks` integer NOT NULL,
  `memory_parents` integer NOT NULL,
  `memory_chunks` integer NOT NULL,
  `last_error` text,
  `rebuild_started_at` text,
  `rebuild_completed_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `retrieval_index_states_project_idx` ON `retrieval_index_states` (`project_id`);--> statement-breakpoint
CREATE INDEX `retrieval_index_states_status_idx` ON `retrieval_index_states` (`status`);--> statement-breakpoint
CREATE TABLE `retrieval_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `kind` text NOT NULL,
  `reason` text NOT NULL,
  `status` text NOT NULL,
  `attempts` integer NOT NULL,
  `error` text,
  `started_at` text,
  `completed_at` text,
  `created_at` text NOT NULL,
  `metadata_json` text
);--> statement-breakpoint
CREATE INDEX `retrieval_jobs_project_status_idx` ON `retrieval_jobs` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `retrieval_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text,
  `corpus_kind` text NOT NULL,
  `query` text NOT NULL,
  `mode` text NOT NULL,
  `filters_json` text NOT NULL,
  `embedding_fingerprint` text,
  `status` text NOT NULL,
  `latency_ms` integer,
  `warnings_json` text,
  `error` text,
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `retrieval_runs_project_created_idx` ON `retrieval_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `retrieval_runs_conversation_idx` ON `retrieval_runs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `retrieval_result_diagnostics` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `rank` integer NOT NULL,
  `chunk_id` text NOT NULL,
  `parent_id` text NOT NULL,
  `raw_score` real NOT NULL,
  `normalized_score` real NOT NULL,
  `recency_reordered` integer NOT NULL,
  `selected` integer NOT NULL,
  `source_ref_json` text NOT NULL,
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `retrieval_result_diagnostics_run_rank_idx` ON `retrieval_result_diagnostics` (`run_id`,`rank`);--> statement-breakpoint
CREATE INDEX `retrieval_result_diagnostics_parent_idx` ON `retrieval_result_diagnostics` (`parent_id`);
