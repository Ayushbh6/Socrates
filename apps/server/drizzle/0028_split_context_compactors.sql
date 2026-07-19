INSERT INTO `worker_model_settings` (`id`, `worker_id`, `provider_id`, `auth_mode`, `model_id`, `thinking_enabled`, `thinking_effort`, `created_at`, `updated_at`, `metadata_json`)
SELECT `id` || '_socrates', 'socrates_context_compactor', `provider_id`, `auth_mode`, `model_id`, `thinking_enabled`, `thinking_effort`, `created_at`, `updated_at`, `metadata_json`
FROM `worker_model_settings`
WHERE `worker_id` = 'context_compactor'
ON CONFLICT(`worker_id`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `worker_model_settings` (`id`, `worker_id`, `provider_id`, `auth_mode`, `model_id`, `thinking_enabled`, `thinking_effort`, `created_at`, `updated_at`, `metadata_json`)
SELECT `id` || '_memory', 'memory_context_compactor', `provider_id`, `auth_mode`, `model_id`, `thinking_enabled`, `thinking_effort`, `created_at`, `updated_at`, `metadata_json`
FROM `worker_model_settings`
WHERE `worker_id` = 'context_compactor'
ON CONFLICT(`worker_id`) DO NOTHING;
--> statement-breakpoint
DELETE FROM `worker_model_settings` WHERE `worker_id` = 'context_compactor';
