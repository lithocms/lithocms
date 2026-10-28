CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_siteId_key_unique" UNIQUE("site_id","key")
);
--> statement-breakpoint
ALTER TABLE "slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "slots_tenant" ON "slots" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);