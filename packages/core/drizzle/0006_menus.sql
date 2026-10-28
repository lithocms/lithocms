CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"location" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_siteId_location_unique" UNIQUE("site_id","location")
);
--> statement-breakpoint
ALTER TABLE "menus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "menus_tenant" ON "menus" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);