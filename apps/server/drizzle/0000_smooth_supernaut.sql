CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text,
	`status` text NOT NULL,
	`action_kind` text NOT NULL,
	`action_json` text NOT NULL,
	`decision` text,
	`decided_by` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`expires_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE INDEX `approvals_turn_idx` ON `approvals` (`turn_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`path` text,
	`content_hash` text,
	`mime_type` text,
	`size_bytes` integer,
	`metadata_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_project_idx` ON `artifacts` (`project_id`);--> statement-breakpoint
CREATE INDEX `artifacts_turn_idx` ON `artifacts` (`turn_id`);--> statement-breakpoint
CREATE TABLE `audio_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`message_id` text NOT NULL,
	`audio_artifact_id` text,
	`provider_id` text,
	`model_id` text,
	`voice_id` text,
	`source_text_hash` text,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `audio_outputs_message_idx` ON `audio_outputs` (`message_id`);--> statement-breakpoint
CREATE INDEX `audio_outputs_turn_idx` ON `audio_outputs` (`turn_id`);--> statement-breakpoint
CREATE TABLE `context_usage_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`model_call_id` text,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`context_window_tokens` integer NOT NULL,
	`context_used_tokens` integer NOT NULL,
	`context_left_tokens` integer NOT NULL,
	`context_used_percent` real NOT NULL,
	`compaction_status` text,
	`created_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `context_usage_conversation_idx` ON `context_usage_snapshots` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `context_usage_turn_idx` ON `context_usage_snapshots` (`turn_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `conversations_project_status_idx` ON `conversations` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `conversations_updated_at_idx` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `errors` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`details_json` text,
	`recoverable` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `errors_code_idx` ON `errors` (`code`);--> statement-breakpoint
CREATE INDEX `errors_turn_idx` ON `errors` (`turn_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`session_id` text,
	`turn_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_sequence_idx` ON `events` (`sequence`);--> statement-breakpoint
CREATE INDEX `events_session_sequence_idx` ON `events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_project_sequence_idx` ON `events` (`project_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_turn_sequence_idx` ON `events` (`turn_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `file_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`operation` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`content_hash_before` text,
	`content_hash_after` text,
	`status` text NOT NULL,
	`error_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `file_operations_turn_idx` ON `file_operations` (`turn_id`);--> statement-breakpoint
CREATE INDEX `file_operations_path_idx` ON `file_operations` (`path`);--> statement-breakpoint
CREATE TABLE `message_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`message_id` text,
	`model_call_id` text,
	`rating` text NOT NULL,
	`reason_code` text,
	`note` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `message_feedback_message_idx` ON `message_feedback` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_feedback_target_idx` ON `message_feedback` (`turn_id`,`model_call_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`content_format` text NOT NULL,
	`status` text NOT NULL,
	`parent_message_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_turn_idx` ON `messages` (`turn_id`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`runtime_config_id` text,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`provider_request_json` text,
	`response_json` text,
	`provider_response_json` text,
	`error_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `model_calls_turn_idx` ON `model_calls` (`turn_id`);--> statement-breakpoint
CREATE INDEX `model_calls_status_idx` ON `model_calls` (`status`);--> statement-breakpoint
CREATE TABLE `model_stream_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`model_call_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`channel` text NOT NULL,
	`text` text,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_stream_chunks_call_sequence_idx` ON `model_stream_chunks` (`model_call_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `model_stream_chunks_turn_idx` ON `model_stream_chunks` (`turn_id`);--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`model_call_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`cached_input_tokens` integer,
	`tool_call_tokens` integer,
	`total_tokens` integer,
	`cost_usd` real,
	`raw_usage_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_usage_turn_idx` ON `model_usage` (`turn_id`);--> statement-breakpoint
CREATE INDEX `model_usage_model_call_idx` ON `model_usage` (`model_call_id`);--> statement-breakpoint
CREATE TABLE `patches` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`diff_text` text NOT NULL,
	`files_json` text,
	`approval_id` text,
	`error_id` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `patches_turn_idx` ON `patches` (`turn_id`);--> statement-breakpoint
CREATE INDEX `patches_status_idx` ON `patches` (`status`);--> statement-breakpoint
CREATE TABLE `project_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `project_instructions_project_status_idx` ON `project_instructions` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`artifact_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`uri` text,
	`status` text NOT NULL,
	`error_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `project_resources_project_idx` ON `project_resources` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_resources_status_idx` ON `project_resources` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`git_repo_root` text,
	`git_branch` text,
	`git_commit` text,
	`is_primary` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `project_workspaces_project_idx` ON `project_workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_workspaces_primary_idx` ON `project_workspaces` (`project_id`,`is_primary`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `projects_user_status_idx` ON `projects` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `projects_updated_at_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`applied_at` text NOT NULL,
	`checksum` text
);
--> statement-breakpoint
CREATE TABLE `session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`active_turn_id` text,
	`last_event_sequence` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_workspace_id` text,
	`workspace_path` text,
	`workspace_name` text,
	`git_repo_root` text,
	`git_branch` text,
	`git_commit` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `sessions_conversation_idx` ON `sessions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `sessions_project_idx` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `shell_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`signal` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `shell_commands_turn_idx` ON `shell_commands` (`turn_id`);--> statement-breakpoint
CREATE INDEX `shell_commands_tool_call_idx` ON `shell_commands` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `shell_output_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`shell_command_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`stream` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shell_output_chunks_command_sequence_idx` ON `shell_output_chunks` (`shell_command_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`model_call_id` text,
	`tool_name` text NOT NULL,
	`status` text NOT NULL,
	`arguments_json` text NOT NULL,
	`result_json` text,
	`error_id` text,
	`requires_approval` integer NOT NULL,
	`approval_id` text,
	`started_at` text,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `tool_calls_turn_idx` ON `tool_calls` (`turn_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_status_idx` ON `tool_calls` (`status`);--> statement-breakpoint
CREATE TABLE `turn_runtime_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`thinking_enabled` integer NOT NULL,
	`thinking_effort` text,
	`approval_mode` text NOT NULL,
	`sandbox_mode` text NOT NULL,
	`temperature` real,
	`max_output_tokens` integer,
	`context_window_tokens` integer,
	`tool_policy_json` text,
	`provider_options_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_runtime_configs_turn_idx` ON `turn_runtime_configs` (`turn_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`failed_at` text,
	`cancelled_at` text,
	`error_id` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `turns_conversation_status_idx` ON `turns` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `turns_session_idx` ON `turns` (`session_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`onboarding_completed` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`onboarded_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `voice_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`message_id` text,
	`audio_artifact_id` text,
	`transcription_provider_id` text,
	`transcription_model_id` text,
	`language` text,
	`transcript_text` text,
	`raw_transcript_json` text,
	`confidence` real,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `voice_inputs_message_idx` ON `voice_inputs` (`message_id`);--> statement-breakpoint
CREATE INDEX `voice_inputs_turn_idx` ON `voice_inputs` (`turn_id`);