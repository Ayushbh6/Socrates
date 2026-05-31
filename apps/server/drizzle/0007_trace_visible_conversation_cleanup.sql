DELETE FROM `trace_embeddings`
WHERE `trace_document_id` IN (
  SELECT `td`.`id`
  FROM `trace_documents` AS `td`
  LEFT JOIN `conversations` AS `c`
    ON `c`.`id` = `td`.`conversation_id`
   AND `c`.`project_id` = `td`.`project_id`
  WHERE `td`.`conversation_id` IS NOT NULL
    AND (`c`.`id` IS NULL OR `c`.`status` NOT IN ('active', 'archived'))
);--> statement-breakpoint
DELETE FROM `trace_documents_fts`
WHERE `trace_document_id` IN (
  SELECT `td`.`id`
  FROM `trace_documents` AS `td`
  LEFT JOIN `conversations` AS `c`
    ON `c`.`id` = `td`.`conversation_id`
   AND `c`.`project_id` = `td`.`project_id`
  WHERE `td`.`conversation_id` IS NOT NULL
    AND (`c`.`id` IS NULL OR `c`.`status` NOT IN ('active', 'archived'))
);--> statement-breakpoint
DELETE FROM `trace_documents`
WHERE `conversation_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `conversations` AS `c`
    WHERE `c`.`id` = `trace_documents`.`conversation_id`
      AND `c`.`project_id` = `trace_documents`.`project_id`
      AND `c`.`status` IN ('active', 'archived')
  );--> statement-breakpoint
DELETE FROM `trace_index_jobs`
WHERE `conversation_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `conversations` AS `c`
    WHERE `c`.`id` = `trace_index_jobs`.`conversation_id`
      AND `c`.`project_id` = `trace_index_jobs`.`project_id`
      AND `c`.`status` IN ('active', 'archived')
  );
