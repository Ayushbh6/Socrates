CREATE TABLE `message_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text,
  `turn_id` text,
  `message_id` text,
  `artifact_id` text NOT NULL,
  `kind` text NOT NULL,
  `file_name` text NOT NULL,
  `mime_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `uri` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `message_attachments_conversation_idx` ON `message_attachments` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `message_attachments_message_idx` ON `message_attachments` (`message_id`);
--> statement-breakpoint
CREATE INDEX `message_attachments_status_idx` ON `message_attachments` (`project_id`,`status`);
