CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid,
	"actor_user_id" uuid,
	"channel" text NOT NULL,
	"token_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"diff" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "post_terms" (
	"site_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "post_terms_post_id_term_id_pk" PRIMARY KEY("post_id","term_id")
);
--> statement-breakpoint
ALTER TABLE "post_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"type" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"author_id" uuid NOT NULL,
	"featured_media_id" uuid,
	"template" text,
	"sections" jsonb,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"comments_open" boolean DEFAULT true NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trashed_at" timestamp with time zone,
	CONSTRAINT "posts_siteId_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "posts_siteId_type_parentId_slug_unique" UNIQUE NULLS NOT DISTINCT("site_id","type","parent_id","slug"),
	CONSTRAINT "posts_page_parent" CHECK ("posts"."parent_id" is null or "posts"."type" = 'page')
);
--> statement-breakpoint
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"site_id" uuid NOT NULL,
	"taxonomy" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_siteId_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "terms_siteId_taxonomy_parentId_slug_unique" UNIQUE NULLS NOT DISTINCT("site_id","taxonomy","parent_id","slug"),
	CONSTRAINT "terms_tag_parent" CHECK ("terms"."parent_id" is null or "terms"."taxonomy" = 'category')
);
--> statement-breakpoint
ALTER TABLE "terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_terms" ADD CONSTRAINT "post_terms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_terms" ADD CONSTRAINT "post_terms_site_id_post_id_posts_site_id_id_fk" FOREIGN KEY ("site_id","post_id") REFERENCES "public"."posts"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_terms" ADD CONSTRAINT "post_terms_site_id_term_id_terms_site_id_id_fk" FOREIGN KEY ("site_id","term_id") REFERENCES "public"."terms"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_site_id_parent_id_posts_site_id_id_fk" FOREIGN KEY ("site_id","parent_id") REFERENCES "public"."posts"("site_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_site_id_post_id_posts_site_id_id_fk" FOREIGN KEY ("site_id","post_id") REFERENCES "public"."posts"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_site_id_parent_id_terms_site_id_id_fk" FOREIGN KEY ("site_id","parent_id") REFERENCES "public"."terms"("site_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_site_id_created_at_index" ON "audit_log" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "post_terms_one_primary" ON "post_terms" USING btree ("post_id") WHERE "post_terms"."is_primary";--> statement-breakpoint
CREATE INDEX "post_terms_term_id_index" ON "post_terms" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "posts_site_id_type_status_published_at_index" ON "posts" USING btree ("site_id","type","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_site_id_slug_index" ON "posts" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "revisions_post_id_created_at_index" ON "revisions" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "terms_site_id_taxonomy_path_index" ON "terms" USING btree ("site_id","taxonomy","path");--> statement-breakpoint
CREATE POLICY "audit_log_read" ON "audit_log" AS PERMISSIVE FOR SELECT TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_write" ON "audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (site_id is null or site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "post_terms_tenant" ON "post_terms" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "posts_tenant" ON "posts" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "revisions_tenant" ON "revisions" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "terms_tenant" ON "terms" AS PERMISSIVE FOR ALL TO public USING (site_id = nullif(current_setting('app.site_id', true), '')::uuid) WITH CHECK (site_id = nullif(current_setting('app.site_id', true), '')::uuid);--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM lithocms_app;
