ALTER TABLE `turn_runtime_configs` ADD `auth_mode` text DEFAULT 'api_key' NOT NULL;
--> statement-breakpoint
ALTER TABLE `memory_agent_global_settings` ADD `auth_mode` text DEFAULT 'api_key' NOT NULL;
--> statement-breakpoint
ALTER TABLE `worker_model_settings` ADD `auth_mode` text DEFAULT 'api_key' NOT NULL;
