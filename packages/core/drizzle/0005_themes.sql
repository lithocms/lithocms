CREATE TABLE "theme_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid,
	"theme_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"storage_path" text NOT NULL,
	"validation_report" jsonb,
	"created_by" uuid,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "theme_versions_themeId_version_unique" UNIQUE("theme_id","version")
);
--> statement-breakpoint
ALTER TABLE "theme_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_siteId_slug_unique" UNIQUE NULLS NOT DISTINCT("site_id","slug"),
	CONSTRAINT "themes_siteId_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "themes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "active_theme_version_id" uuid;--> statement-breakpoint
ALTER TABLE "theme_versions" ADD CONSTRAINT "theme_versions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_versions" ADD CONSTRAINT "theme_versions_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_versions" ADD CONSTRAINT "theme_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_versions" ADD CONSTRAINT "theme_versions_site_id_theme_id_themes_site_id_id_fk" FOREIGN KEY ("site_id","theme_id") REFERENCES "public"."themes"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_active_theme_version_id_theme_versions_id_fk" FOREIGN KEY ("active_theme_version_id") REFERENCES "public"."theme_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "theme_versions_read" ON "theme_versions" AS PERMISSIVE FOR SELECT TO public USING (site_id is null or site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "theme_versions_write" ON "theme_versions" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "themes_read" ON "themes" AS PERMISSIVE FOR SELECT TO public USING (site_id is null or site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "themes_write" ON "themes" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);