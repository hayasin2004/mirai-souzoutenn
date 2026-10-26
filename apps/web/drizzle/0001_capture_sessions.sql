CREATE TABLE `capture_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`dir_path` text NOT NULL,
	`session_path` text NOT NULL,
	`quality_status` text NOT NULL,
	`recorded_steps` integer NOT NULL,
	`has_video` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `capture_sessions_person_idx` ON `capture_sessions` (`person_id`);--> statement-breakpoint
ALTER TABLE `avatar_assets` ADD `capture_session_id` text REFERENCES capture_sessions(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `persons` ADD `is_stage_subject` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `persons_one_stage_subject` ON `persons` (`is_stage_subject`) WHERE "persons"."is_stage_subject" = 1;