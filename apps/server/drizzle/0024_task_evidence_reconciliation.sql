CREATE TABLE `agent_task_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `kind` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_turns_task_ordinal_idx` ON `agent_task_turns` (`task_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_turns_turn_idx` ON `agent_task_turns` (`turn_id`);
--> statement-breakpoint
CREATE TABLE `task_evidence_references` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `kind` text NOT NULL,
  `selector_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_evidence_references_task_idx` ON `task_evidence_references` (`task_id`);
