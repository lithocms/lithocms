ALTER TABLE "posts" ADD COLUMN "search" "tsvector";--> statement-breakpoint
CREATE INDEX "posts_search_index" ON "posts" USING gin ("search");--> statement-breakpoint
-- Diacritic-insensitive search per language: unaccent before the stemmer.
-- `unaccent` is a trusted extension, so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION litho_tr (COPY = turkish);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION litho_tr ALTER MAPPING FOR hword, hword_part, word WITH unaccent, turkish_stem;--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION litho_en (COPY = english);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION litho_en ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION litho_simple (COPY = simple);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION litho_simple ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;--> statement-breakpoint
CREATE FUNCTION litho_search_config(locale text) RETURNS regconfig
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE locale WHEN 'tr' THEN 'public.litho_tr'::regconfig WHEN 'en' THEN 'public.litho_en'::regconfig ELSE 'public.litho_simple'::regconfig END;--> statement-breakpoint
-- The language comes from the site, so this is a trigger rather than a generated column.
-- Content text is every ProseMirror text node; no HTML involved.
CREATE FUNCTION litho_posts_search() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  cfg regconfig := litho_search_config((SELECT locale FROM sites WHERE id = NEW.site_id));
  body text := (SELECT string_agg(t #>> '{}', ' ') FROM jsonb_path_query(NEW.content, 'strict $.**.text') t);
BEGIN
  NEW.search :=
    setweight(to_tsvector(cfg, NEW.title), 'A') ||
    setweight(to_tsvector(cfg, NEW.excerpt), 'B') ||
    setweight(to_tsvector(cfg, left(coalesce(body, ''), 500000)), 'D');
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER posts_search BEFORE INSERT OR UPDATE OF title, excerpt, content ON posts
  FOR EACH ROW EXECUTE FUNCTION litho_posts_search();--> statement-breakpoint
UPDATE posts SET title = title;
