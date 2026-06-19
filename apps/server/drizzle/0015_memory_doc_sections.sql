CREATE TABLE `memory_doc_indexes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`doc_type` text NOT NULL,
	`owner_tool` text NOT NULL,
	`schema_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`section_count` integer NOT NULL,
	`indexed_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_doc_indexes_scope_project_path_idx` ON `memory_doc_indexes` (`scope`,`project_id`,`path`);
--> statement-breakpoint
CREATE INDEX `memory_doc_indexes_project_idx` ON `memory_doc_indexes` (`project_id`);
--> statement-breakpoint
CREATE TABLE `memory_doc_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_index_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`doc_type` text NOT NULL,
	`section_id` text NOT NULL,
	`kind` text NOT NULL,
	`tags_json` text NOT NULL,
	`heading` text NOT NULL,
	`line_start` integer NOT NULL,
	`line_end` integer NOT NULL,
	`content_hash` text NOT NULL,
	`summary` text NOT NULL,
	`token_estimate` integer NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text,
	FOREIGN KEY (`doc_index_id`) REFERENCES `memory_doc_indexes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_doc_sections_doc_section_idx` ON `memory_doc_sections` (`doc_index_id`,`section_id`);
--> statement-breakpoint
CREATE INDEX `memory_doc_sections_lookup_idx` ON `memory_doc_sections` (`scope`,`project_id`,`doc_type`,`section_id`);
