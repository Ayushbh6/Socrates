CREATE TABLE `context_compaction_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`previous_snapshot_id` text,
	`status` text NOT NULL,
	`active` integer NOT NULL,
	`reason` text NOT NULL,
	`source_message_ids_json` text NOT NULL,
	`source_turn_ids_json` text NOT NULL,
	`summary_json` text,
	`rendered_summary` text,
	`source_handles_json` text,
	`input_tokens_estimate` integer,
	`output_tokens_estimate` integer,
	`context_tokens_before` integer NOT NULL,
	`context_tokens_after` integer,
	`target_tokens` integer NOT NULL,
	`compressor_provider_id` text NOT NULL,
	`compressor_model_id` text NOT NULL,
	`usage_json` text,
	`error_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `context_compaction_conversation_active_idx` ON `context_compaction_snapshots` (`conversation_id`,`active`);--> statement-breakpoint
CREATE INDEX `context_compaction_turn_idx` ON `context_compaction_snapshots` (`turn_id`);--> statement-breakpoint
CREATE INDEX `context_compaction_status_idx` ON `context_compaction_snapshots` (`status`);
