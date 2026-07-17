CREATE TABLE `v2_agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`root_turn_id` text NOT NULL,
	`current_turn_id` text NOT NULL,
	`status` text NOT NULL,
	`runtime_config_json` text NOT NULL,
	`waiting_on_terminal_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `v2_agent_tasks_flow_status_idx` ON `v2_agent_tasks` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_agent_tasks_goal_status_idx` ON `v2_agent_tasks` (`goal_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_agent_tasks_current_turn_idx` ON `v2_agent_tasks` (`current_turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_agent_tasks_root_turn_idx` ON `v2_agent_tasks` (`root_turn_id`);--> statement-breakpoint
CREATE TABLE `v2_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text NOT NULL,
	`tool_call_id` text,
	`status` text NOT NULL,
	`action_kind` text NOT NULL,
	`action_json` text NOT NULL,
	`decision` text,
	`reason` text,
	`decided_by` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`expires_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `v2_approvals_flow_status_idx` ON `v2_approvals` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_approvals_turn_idx` ON `v2_approvals` (`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_approvals_tool_call_idx` ON `v2_approvals` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `v2_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`path` text,
	`uri` text,
	`content_hash` text,
	`mime_type` text,
	`size_bytes` integer,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_artifacts_size_check" CHECK("v2_artifacts"."size_bytes" IS NULL OR "v2_artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `v2_artifacts_flow_created_idx` ON `v2_artifacts` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_artifacts_goal_created_idx` ON `v2_artifacts` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_artifacts_turn_idx` ON `v2_artifacts` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_artifacts_content_hash_idx` ON `v2_artifacts` (`content_hash`);--> statement-breakpoint
CREATE TABLE `v2_context_dispositions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text NOT NULL,
	`context_item_id` text NOT NULL,
	`version` integer NOT NULL,
	`disposition` text NOT NULL,
	`reason` text NOT NULL,
	`decided_by` text NOT NULL,
	`unresolved_age_turns` integer,
	`unresolved_max_age_turns` integer,
	`distillation_instruction` text,
	`replacement_context_item_id` text,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_context_dispositions_version_check" CHECK("v2_context_dispositions"."version" > 0),
	CONSTRAINT "v2_context_dispositions_unresolved_bounds_check" CHECK(("v2_context_dispositions"."disposition" = 'unresolved' AND "v2_context_dispositions"."unresolved_age_turns" IS NOT NULL AND "v2_context_dispositions"."unresolved_max_age_turns" IS NOT NULL AND "v2_context_dispositions"."unresolved_age_turns" >= 0 AND "v2_context_dispositions"."unresolved_max_age_turns" BETWEEN 1 AND 3 AND "v2_context_dispositions"."unresolved_age_turns" <= "v2_context_dispositions"."unresolved_max_age_turns") OR ("v2_context_dispositions"."disposition" <> 'unresolved' AND "v2_context_dispositions"."unresolved_age_turns" IS NULL AND "v2_context_dispositions"."unresolved_max_age_turns" IS NULL)),
	CONSTRAINT "v2_context_dispositions_distill_instruction_check" CHECK("v2_context_dispositions"."disposition" <> 'distill' OR "v2_context_dispositions"."distillation_instruction" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_context_dispositions_item_version_idx` ON `v2_context_dispositions` (`context_item_id`,`version`);--> statement-breakpoint
CREATE INDEX `v2_context_dispositions_flow_created_idx` ON `v2_context_dispositions` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_context_dispositions_goal_disposition_idx` ON `v2_context_dispositions` (`goal_id`,`disposition`);--> statement-breakpoint
CREATE INDEX `v2_context_dispositions_turn_idx` ON `v2_context_dispositions` (`turn_id`);--> statement-breakpoint
CREATE TABLE `v2_context_item_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`context_item_id` text NOT NULL,
	`evidence_item_id` text,
	`message_id` text,
	`capsule_id` text,
	`source_order` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_context_item_sources_order_check" CHECK("v2_context_item_sources"."source_order" >= 0),
	CONSTRAINT "v2_context_item_sources_exactly_one_check" CHECK((CASE WHEN "v2_context_item_sources"."evidence_item_id" IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN "v2_context_item_sources"."message_id" IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN "v2_context_item_sources"."capsule_id" IS NOT NULL THEN 1 ELSE 0 END) = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_context_item_sources_item_order_idx` ON `v2_context_item_sources` (`context_item_id`,`source_order`);--> statement-breakpoint
CREATE INDEX `v2_context_item_sources_evidence_idx` ON `v2_context_item_sources` (`evidence_item_id`);--> statement-breakpoint
CREATE INDEX `v2_context_item_sources_message_idx` ON `v2_context_item_sources` (`message_id`);--> statement-breakpoint
CREATE INDEX `v2_context_item_sources_capsule_idx` ON `v2_context_item_sources` (`capsule_id`);--> statement-breakpoint
CREATE TABLE `v2_context_items` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`content` text NOT NULL,
	`token_estimate` integer NOT NULL,
	`rank` integer NOT NULL,
	`active_from_turn_ordinal` integer NOT NULL,
	`released_at_turn_ordinal` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_context_items_token_check" CHECK("v2_context_items"."token_estimate" >= 0),
	CONSTRAINT "v2_context_items_rank_check" CHECK("v2_context_items"."rank" >= 0),
	CONSTRAINT "v2_context_items_active_ordinal_check" CHECK("v2_context_items"."active_from_turn_ordinal" > 0),
	CONSTRAINT "v2_context_items_release_ordinal_check" CHECK("v2_context_items"."released_at_turn_ordinal" IS NULL OR "v2_context_items"."released_at_turn_ordinal" >= "v2_context_items"."active_from_turn_ordinal")
);
--> statement-breakpoint
CREATE INDEX `v2_context_items_flow_state_rank_idx` ON `v2_context_items` (`flow_id`,`state`,`rank`);--> statement-breakpoint
CREATE INDEX `v2_context_items_goal_state_idx` ON `v2_context_items` (`goal_id`,`state`);--> statement-breakpoint
CREATE INDEX `v2_context_items_turn_idx` ON `v2_context_items` (`turn_id`);--> statement-breakpoint
CREATE TABLE `v2_credential_input_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`provider_tool_call_id` text,
	`server_id` text NOT NULL,
	`server_label` text,
	`env_key` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_credential_input_requests_status_check" CHECK("v2_credential_input_requests"."status" IN ('pending', 'submitted', 'cancelled', 'expired')),
	CONSTRAINT "v2_credential_input_requests_source_check" CHECK("v2_credential_input_requests"."source" IN ('user_input', 'workspace_env'))
);
--> statement-breakpoint
CREATE INDEX `v2_credential_input_requests_flow_status_idx` ON `v2_credential_input_requests` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_credential_input_requests_turn_status_idx` ON `v2_credential_input_requests` (`turn_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_credential_input_requests_tool_call_idx` ON `v2_credential_input_requests` (`tool_call_id`,`env_key`);--> statement-breakpoint
CREATE TABLE `v2_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
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
CREATE INDEX `v2_errors_flow_created_idx` ON `v2_errors` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_errors_turn_idx` ON `v2_errors` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_errors_code_idx` ON `v2_errors` (`code`);--> statement-breakpoint
CREATE TABLE `v2_evidence_items` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`source_kind` text NOT NULL,
	`source_id` text,
	`source_uri` text,
	`title` text NOT NULL,
	`mime_type` text,
	`content` text,
	`content_hash` text NOT NULL,
	`size_bytes` integer,
	`token_estimate` integer,
	`locator_json` text,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_evidence_items_size_check" CHECK("v2_evidence_items"."size_bytes" IS NULL OR "v2_evidence_items"."size_bytes" >= 0),
	CONSTRAINT "v2_evidence_items_token_check" CHECK("v2_evidence_items"."token_estimate" IS NULL OR "v2_evidence_items"."token_estimate" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_evidence_items_handle_idx` ON `v2_evidence_items` (`handle`);--> statement-breakpoint
CREATE INDEX `v2_evidence_items_flow_created_idx` ON `v2_evidence_items` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_evidence_items_goal_created_idx` ON `v2_evidence_items` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_evidence_items_source_idx` ON `v2_evidence_items` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `v2_evidence_items_content_hash_idx` ON `v2_evidence_items` (`flow_id`,`content_hash`);--> statement-breakpoint
CREATE TRIGGER `v2_evidence_items_no_update`
BEFORE UPDATE ON `v2_evidence_items`
BEGIN
	SELECT RAISE(ABORT, 'V2 evidence is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `v2_evidence_items_no_delete`
BEFORE DELETE ON `v2_evidence_items`
BEGIN
	SELECT RAISE(ABORT, 'V2 evidence is immutable');
END;--> statement-breakpoint
CREATE TABLE `v2_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`message_id` text NOT NULL,
	`model_call_id` text,
	`rating` text NOT NULL,
	`reason_code` text,
	`note` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_feedback_rating_check" CHECK("v2_feedback"."rating" IN ('thumbs_up', 'thumbs_down'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_feedback_message_idx` ON `v2_feedback` (`message_id`);--> statement-breakpoint
CREATE INDEX `v2_feedback_flow_created_idx` ON `v2_feedback` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_feedback_goal_created_idx` ON `v2_feedback` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_feedback_target_idx` ON `v2_feedback` (`turn_id`,`model_call_id`);--> statement-breakpoint
CREATE TABLE `v2_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`foreground_goal_id` text,
	`context_policy_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_event_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_flows_revision_check" CHECK("v2_flows"."revision" >= 0),
	CONSTRAINT "v2_flows_event_sequence_check" CHECK("v2_flows"."last_event_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_flows_project_idx` ON `v2_flows` (`project_id`);--> statement-breakpoint
CREATE INDEX `v2_flows_status_updated_idx` ON `v2_flows` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `v2_goal_capsules` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`decisions_json` text NOT NULL,
	`open_questions_json` text NOT NULL,
	`next_actions_json` text NOT NULL,
	`evidence_handles_json` text NOT NULL,
	`source_through_sequence` integer NOT NULL,
	`token_estimate` integer NOT NULL,
	`created_by_turn_id` text,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_goal_capsules_version_check" CHECK("v2_goal_capsules"."version" > 0),
	CONSTRAINT "v2_goal_capsules_source_sequence_check" CHECK("v2_goal_capsules"."source_through_sequence" >= 0),
	CONSTRAINT "v2_goal_capsules_token_estimate_check" CHECK("v2_goal_capsules"."token_estimate" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_capsules_goal_version_idx` ON `v2_goal_capsules` (`goal_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_capsules_one_active_idx` ON `v2_goal_capsules` (`goal_id`) WHERE "v2_goal_capsules"."status" = 'active';--> statement-breakpoint
CREATE INDEX `v2_goal_capsules_flow_created_idx` ON `v2_goal_capsules` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `v2_goal_message_links` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`message_id` text NOT NULL,
	`turn_id` text,
	`relation` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_message_links_goal_message_idx` ON `v2_goal_message_links` (`goal_id`,`message_id`,`relation`);--> statement-breakpoint
CREATE INDEX `v2_goal_message_links_message_idx` ON `v2_goal_message_links` (`message_id`);--> statement-breakpoint
CREATE INDEX `v2_goal_message_links_flow_created_idx` ON `v2_goal_message_links` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `v2_goal_routing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`message_id` text NOT NULL,
	`foreground_goal_id` text,
	`candidate_goal_ids_json` text NOT NULL,
	`selected_goal_id` text,
	`decision` text,
	`confidence` real,
	`rationale` text,
	`provider_id` text,
	`model_id` text,
	`status` text NOT NULL,
	`fallback_reason` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_goal_routing_runs_confidence_check" CHECK("v2_goal_routing_runs"."confidence" IS NULL OR ("v2_goal_routing_runs"."confidence" >= 0 AND "v2_goal_routing_runs"."confidence" <= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_routing_runs_turn_idx` ON `v2_goal_routing_runs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_goal_routing_runs_flow_started_idx` ON `v2_goal_routing_runs` (`flow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `v2_goal_routing_runs_selected_goal_idx` ON `v2_goal_routing_runs` (`selected_goal_id`);--> statement-breakpoint
CREATE TABLE `v2_goal_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`turn_id` text,
	`routing_run_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_goal_transitions_sequence_check" CHECK("v2_goal_transitions"."sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goal_transitions_flow_sequence_idx` ON `v2_goal_transitions` (`flow_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_goal_transitions_goal_created_idx` ON `v2_goal_transitions` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_goal_transitions_turn_idx` ON `v2_goal_transitions` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_goal_transitions_routing_run_idx` ON `v2_goal_transitions` (`routing_run_id`);--> statement-breakpoint
CREATE TABLE `v2_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`last_active_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`archived_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_goals_ordinal_check" CHECK("v2_goals"."ordinal" > 0),
	CONSTRAINT "v2_goals_priority_check" CHECK("v2_goals"."priority" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goals_flow_ordinal_idx` ON `v2_goals` (`flow_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_goals_one_foreground_idx` ON `v2_goals` (`flow_id`) WHERE "v2_goals"."status" = 'foreground';--> statement-breakpoint
CREATE INDEX `v2_goals_flow_status_idx` ON `v2_goals` (`flow_id`,`status`,`last_active_at`);--> statement-breakpoint
CREATE INDEX `v2_goals_project_status_idx` ON `v2_goals` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `v2_message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`goal_id` text,
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
	`metadata_json` text,
	CONSTRAINT "v2_message_attachments_size_check" CHECK("v2_message_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `v2_message_attachments_flow_created_idx` ON `v2_message_attachments` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_message_attachments_message_idx` ON `v2_message_attachments` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `v2_message_attachments_artifact_idx` ON `v2_message_attachments` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `v2_message_attachments_project_status_idx` ON `v2_message_attachments` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `v2_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`ordinal` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`reasoning` text,
	`content_format` text DEFAULT 'markdown' NOT NULL,
	`status` text NOT NULL,
	`parent_message_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_messages_ordinal_check" CHECK("v2_messages"."ordinal" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_messages_flow_ordinal_idx` ON `v2_messages` (`flow_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `v2_messages_turn_idx` ON `v2_messages` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_messages_goal_created_idx` ON `v2_messages` (`goal_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_messages_project_created_idx` ON `v2_messages` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `v2_model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`role` text NOT NULL,
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
CREATE INDEX `v2_model_calls_turn_idx` ON `v2_model_calls` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_model_calls_flow_started_idx` ON `v2_model_calls` (`flow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `v2_model_calls_role_status_idx` ON `v2_model_calls` (`role`,`status`);--> statement-breakpoint
CREATE TABLE `v2_runtime_events` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_runtime_events_sequence_check" CHECK("v2_runtime_events"."sequence" > 0),
	CONSTRAINT "v2_runtime_events_type_check" CHECK("v2_runtime_events"."type" LIKE 'v2.%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_runtime_events_flow_sequence_idx` ON `v2_runtime_events` (`flow_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_runtime_events_project_sequence_idx` ON `v2_runtime_events` (`project_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_runtime_events_goal_sequence_idx` ON `v2_runtime_events` (`goal_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_runtime_events_turn_sequence_idx` ON `v2_runtime_events` (`turn_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_runtime_events_type_idx` ON `v2_runtime_events` (`type`);--> statement-breakpoint
CREATE TABLE `v2_speech_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`message_id` text,
	`kind` text NOT NULL,
	`engine` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`input_artifact_id` text,
	`input_text` text,
	`output_artifact_id` text,
	`transcript_text` text,
	`voice_id` text,
	`speed` real,
	`language` text,
	`duration_ms` integer,
	`error_id` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_speech_jobs_engine_model_allowlist_check" CHECK(("v2_speech_jobs"."kind" = 'transcription' AND "v2_speech_jobs"."engine" = 'local_whisper' AND "v2_speech_jobs"."model_id" IN ('base.en', 'small.en') AND "v2_speech_jobs"."input_artifact_id" IS NOT NULL AND "v2_speech_jobs"."input_text" IS NULL AND "v2_speech_jobs"."voice_id" IS NULL AND "v2_speech_jobs"."speed" IS NULL) OR ("v2_speech_jobs"."kind" = 'transcription' AND "v2_speech_jobs"."engine" = 'openrouter' AND "v2_speech_jobs"."model_id" IN ('nvidia/parakeet-tdt-0.6b-v3', 'microsoft/mai-transcribe-1.5', 'mistralai/voxtral-mini-transcribe') AND "v2_speech_jobs"."input_artifact_id" IS NOT NULL AND "v2_speech_jobs"."input_text" IS NULL AND "v2_speech_jobs"."voice_id" IS NULL AND "v2_speech_jobs"."speed" IS NULL) OR ("v2_speech_jobs"."kind" = 'synthesis' AND "v2_speech_jobs"."engine" = 'local_kokoro' AND "v2_speech_jobs"."model_id" = 'kokoro-82m' AND "v2_speech_jobs"."input_artifact_id" IS NULL AND "v2_speech_jobs"."input_text" IS NOT NULL AND "v2_speech_jobs"."voice_id" IS NOT NULL AND "v2_speech_jobs"."speed" BETWEEN 0.5 AND 2 AND "v2_speech_jobs"."transcript_text" IS NULL)),
	CONSTRAINT "v2_speech_jobs_duration_check" CHECK("v2_speech_jobs"."duration_ms" IS NULL OR "v2_speech_jobs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `v2_speech_jobs_flow_status_idx` ON `v2_speech_jobs` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_speech_jobs_message_idx` ON `v2_speech_jobs` (`message_id`);--> statement-breakpoint
CREATE INDEX `v2_speech_jobs_turn_idx` ON `v2_speech_jobs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_speech_jobs_engine_model_idx` ON `v2_speech_jobs` (`engine`,`model_id`);--> statement-breakpoint
CREATE TABLE `v2_terminal_output_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`terminal_session_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`stream` text NOT NULL,
	`text` text NOT NULL,
	`redacted` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_terminal_output_chunks_sequence_check" CHECK("v2_terminal_output_chunks"."sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_terminal_output_chunks_terminal_sequence_idx` ON `v2_terminal_output_chunks` (`terminal_session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `v2_terminal_output_chunks_flow_created_idx` ON `v2_terminal_output_chunks` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `v2_terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`workspace_path` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`platform` text,
	`shell_kind` text,
	`shell_executable` text,
	`process_id` text,
	`exit_code` integer,
	`signal` text,
	`auto_detached` integer NOT NULL,
	`awaiting_input` integer NOT NULL,
	`state_version` integer DEFAULT 0 NOT NULL,
	`last_prompt` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_terminal_sessions_state_version_check" CHECK("v2_terminal_sessions"."state_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX `v2_terminal_sessions_flow_status_idx` ON `v2_terminal_sessions` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_terminal_sessions_goal_status_idx` ON `v2_terminal_sessions` (`goal_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_terminal_sessions_turn_idx` ON `v2_terminal_sessions` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_terminal_sessions_process_idx` ON `v2_terminal_sessions` (`process_id`);--> statement-breakpoint
CREATE TABLE `v2_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text NOT NULL,
	`model_call_id` text,
	`provider_tool_call_id` text,
	`tool_name` text NOT NULL,
	`status` text NOT NULL,
	`arguments_json` text NOT NULL,
	`result_json` text,
	`requires_approval` integer NOT NULL,
	`approval_id` text,
	`error_id` text,
	`started_at` text,
	`completed_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `v2_tool_calls_turn_idx` ON `v2_tool_calls` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_tool_calls_flow_status_idx` ON `v2_tool_calls` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_tool_calls_goal_started_idx` ON `v2_tool_calls` (`goal_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `v2_tool_calls_approval_idx` ON `v2_tool_calls` (`approval_id`);--> statement-breakpoint
CREATE TABLE `v2_turn_runtime_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`auth_mode` text DEFAULT 'api_key' NOT NULL,
	`model_id` text NOT NULL,
	`thinking_enabled` integer NOT NULL,
	`thinking_effort` text,
	`approval_mode` text NOT NULL,
	`sandbox_mode` text NOT NULL,
	`context_window_tokens` integer,
	`provider_options_json` text,
	`tool_policy_json` text,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_turn_runtime_configs_context_window_check" CHECK("v2_turn_runtime_configs"."context_window_tokens" IS NULL OR "v2_turn_runtime_configs"."context_window_tokens" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_turn_runtime_configs_turn_idx` ON `v2_turn_runtime_configs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `v2_turn_runtime_configs_flow_idx` ON `v2_turn_runtime_configs` (`flow_id`);--> statement-breakpoint
CREATE TABLE `v2_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`ordinal` integer NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text,
	`status` text NOT NULL,
	`waiting_reason` text,
	`error_id` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`failed_at` text,
	`cancelled_at` text,
	`metadata_json` text,
	CONSTRAINT "v2_turns_ordinal_check" CHECK("v2_turns"."ordinal" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_turns_flow_ordinal_idx` ON `v2_turns` (`flow_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `v2_turns_flow_status_idx` ON `v2_turns` (`flow_id`,`status`);--> statement-breakpoint
CREATE INDEX `v2_turns_goal_started_idx` ON `v2_turns` (`goal_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `v2_turns_project_status_idx` ON `v2_turns` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `v2_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`turn_id` text,
	`model_call_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`cost_usd` real,
	`cost_source` text NOT NULL,
	`raw_usage_json` text,
	`created_at` text NOT NULL,
	`metadata_json` text,
	CONSTRAINT "v2_usage_events_token_check" CHECK("v2_usage_events"."input_tokens" >= 0 AND "v2_usage_events"."output_tokens" >= 0 AND "v2_usage_events"."reasoning_tokens" >= 0 AND "v2_usage_events"."cached_input_tokens" >= 0 AND "v2_usage_events"."total_tokens" >= 0),
	CONSTRAINT "v2_usage_events_cost_check" CHECK("v2_usage_events"."cost_usd" IS NULL OR "v2_usage_events"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_usage_events_model_call_idx` ON `v2_usage_events` (`model_call_id`);--> statement-breakpoint
CREATE INDEX `v2_usage_events_flow_created_idx` ON `v2_usage_events` (`flow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `v2_usage_events_turn_idx` ON `v2_usage_events` (`turn_id`);
