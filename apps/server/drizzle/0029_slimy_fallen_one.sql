CREATE TABLE `v2_classic_turn_goal_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`bridge_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_classic_turn_goal_links_turn_idx` ON `v2_classic_turn_goal_links` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_classic_turn_goal_links_goal_created_idx` ON `v2_classic_turn_goal_links` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_classic_turn_goal_links_conversation_created_idx` ON `v2_classic_turn_goal_links` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `v2_goal_classic_homes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`bridge_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_classic_homes_goal_idx` ON `v2_goal_classic_homes` (`goal_id`);--> statement-breakpoint
CREATE INDEX `v2_goal_classic_homes_conversation_idx` ON `v2_goal_classic_homes` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `v2_goal_classic_homes_flow_idx` ON `v2_goal_classic_homes` (`flow_id`);--> statement-breakpoint
INSERT INTO `v2_goal_classic_homes` (`id`, `project_id`, `flow_id`, `goal_id`, `bridge_id`, `conversation_id`, `session_id`, `created_at`, `updated_at`)
SELECT 'v2home_' || lower(hex(randomblob(12))), `project_id`, `flow_id`, `goal_id`, `id`, `conversation_id`, `session_id`, `created_at`, `updated_at`
FROM `v2_classic_conversation_bridges`;--> statement-breakpoint
DROP INDEX `v2_classic_bridges_goal_idx`;--> statement-breakpoint
CREATE INDEX `v2_classic_bridges_goal_idx` ON `v2_classic_conversation_bridges` (`goal_id`);
