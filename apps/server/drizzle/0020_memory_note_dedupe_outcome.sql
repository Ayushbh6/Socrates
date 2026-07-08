ALTER TABLE `memory_notes` ADD `normalized_note_key` text;--> statement-breakpoint
ALTER TABLE `memory_notes` ADD `outcome` text;--> statement-breakpoint
CREATE INDEX `memory_notes_normalized_key_idx` ON `memory_notes` (`normalized_note_key`);--> statement-breakpoint
CREATE INDEX `memory_notes_source_turn_agent_key_idx` ON `memory_notes` (`turn_id`,`created_by_agent`,`normalized_note_key`);
