CREATE TABLE "page_cache" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_cache_siteId_path_unique" UNIQUE("site_id","path"),
	CONSTRAINT "page_cache_siteId_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "page_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "page_cache_tags" (
	"site_id" uuid NOT NULL,
	"cache_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "page_cache_tags_cache_id_tag_pk" PRIMARY KEY("cache_id","tag")
);
--> statement-breakpoint
ALTER TABLE "page_cache_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "cache_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_cache" ADD CONSTRAINT "page_cache_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cache_tags" ADD CONSTRAINT "page_cache_tags_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cache_tags" ADD CONSTRAINT "page_cache_tags_site_id_cache_id_page_cache_site_id_id_fk" FOREIGN KEY ("site_id","cache_id") REFERENCES "public"."page_cache"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_cache_tags_site_id_tag_index" ON "page_cache_tags" USING btree ("site_id","tag");--> statement-breakpoint
CREATE POLICY "page_cache_tenant" ON "page_cache" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "page_cache_tags_tenant" ON "page_cache_tags" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);