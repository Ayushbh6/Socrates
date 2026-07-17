CREATE TABLE `v2_classic_conversation_bridges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`active_owner` text DEFAULT 'v2' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_v2_message_ordinal` integer DEFAULT 0 NOT NULL,
	`last_classic_message_created_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_classic_bridges_owner_check" CHECK("v2_classic_conversation_bridges"."active_owner" IN ('v2', 'classic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_classic_bridges_goal_idx` ON `v2_classic_conversation_bridges` (`goal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_classic_bridges_conversation_idx` ON `v2_classic_conversation_bridges` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `v2_classic_bridges_flow_status_idx` ON `v2_classic_conversation_bridges` (`flow_id`,`status`);--> statement-breakpoint
CREATE TABLE `v2_classic_message_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bridge_id` text NOT NULL,
	`v2_message_id` text NOT NULL,
	`classic_message_id` text NOT NULL,
	`direction` text NOT NULL,
	`source_runtime` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_classic_message_links_direction_check" CHECK("v2_classic_message_links"."direction" IN ('v2_to_classic', 'classic_to_v2')),
	CONSTRAINT "v2_classic_message_links_runtime_check" CHECK("v2_classic_message_links"."source_runtime" IN ('v2', 'classic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_classic_message_links_v2_idx` ON `v2_classic_message_links` (`v2_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_classic_message_links_classic_idx` ON `v2_classic_message_links` (`classic_message_id`);--> statement-breakpoint
CREATE INDEX `v2_classic_message_links_bridge_idx` ON `v2_classic_message_links` (`bridge_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `v2_goal_routing_runs` ADD `clarification_question` text;--> statement-breakpoint
ALTER TABLE `v2_goal_routing_runs` ADD `clarification_candidate_goal_ids_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `v2_goal_routing_runs` ADD `clarification_answer_message_id` text;--> statement-breakpoint
ALTER TABLE `v2_goals` ADD `kind` text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE `v2_goals` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `v2_messages` ADD `kind` text DEFAULT 'standard' NOT NULL;