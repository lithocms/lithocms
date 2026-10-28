CREATE TABLE "site_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"tls_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "site_domains_domain_lowercase" CHECK ("site_domains"."domain" = lower("site_domains"."domain"))
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_one_primary" ON "site_domains" USING btree ("site_id") WHERE "site_domains"."is_primary";