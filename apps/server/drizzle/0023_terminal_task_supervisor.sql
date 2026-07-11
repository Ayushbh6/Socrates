CREATE TABLE `agent_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL,
  `root_turn_id` text NOT NULL,
  `current_turn_id` text NOT NULL,
  `status` text NOT NULL,
  `runtime_config_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  `metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_conversation_status_idx` ON `agent_tasks` (`conversation_id`,`status`);
--> statement-breakpoint
CREATE INDEX `agent_tasks_current_turn_idx` ON `agent_tasks` (`current_turn_id`);
--> statement-breakpoint
CREATE TABLE `agent_task_waits` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `terminal_id` text NOT NULL,
  `wake_on_json` text NOT NULL,
  `reason` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `woken_at` text,
  `wake_event` text
);
--> statement-breakpoint
CREATE INDEX `agent_task_waits_terminal_status_idx` ON `agent_task_waits` (`terminal_id`,`status`);
--> statement-breakpoint
CREATE INDEX `agent_task_waits_task_status_idx` ON `agent_task_waits` (`task_id`,`status`);
