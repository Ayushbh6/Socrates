CREATE TABLE `v2_deletion_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "v2_deletion_authorizations_kind_check" CHECK("v2_deletion_authorizations"."target_kind" IN ('turn', 'goal', 'flow'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v2_deletion_authorizations_target_idx` ON `v2_deletion_authorizations` (`target_kind`,`target_id`);--> statement-breakpoint
DROP TRIGGER `v2_evidence_items_no_delete`;--> statement-breakpoint
CREATE TRIGGER `v2_evidence_items_no_delete`
BEFORE DELETE ON `v2_evidence_items`
WHEN NOT EXISTS (
	SELECT 1
	FROM `v2_deletion_authorizations`
	WHERE (`target_kind` = 'turn' AND `target_id` = OLD.`turn_id`)
		OR (`target_kind` = 'goal' AND `target_id` = OLD.`goal_id`)
		OR (`target_kind` = 'flow' AND `target_id` = OLD.`flow_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'V2 evidence is immutable');
END;
