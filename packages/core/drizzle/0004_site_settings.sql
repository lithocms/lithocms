ALTER TABLE "sites" ADD COLUMN "permalinks" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;