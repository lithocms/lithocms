CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"to" text DEFAULT '' NOT NULL,
	"code" integer DEFAULT 301 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_siteId_fromPath_unique" UNIQUE("site_id","from_path"),
	CONSTRAINT "redirects_code" CHECK ("redirects"."code" in (301, 302, 410))
);
--> statement-breakpoint
ALTER TABLE "redirects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "redirects_tenant" ON "redirects" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);