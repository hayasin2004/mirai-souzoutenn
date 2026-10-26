CREATE TABLE `avatar_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`source_photo_path` text NOT NULL,
	`face_path` text NOT NULL,
	`landmarks_path` text NOT NULL,
	`quality_status` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avatar_assets_person_idx` ON `avatar_assets` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `avatar_assets_one_active_per_person` ON `avatar_assets` (`person_id`) WHERE "avatar_assets"."is_active" = 1;--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`consent_at` integer,
	`created_at` integer NOT NULL
);
