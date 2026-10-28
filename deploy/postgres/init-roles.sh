#!/bin/sh
# Runs once, on first start of an empty Postgres volume (docker-entrypoint-initdb.d).
# Creates the two roles LithoCMS uses; the superuser is never used by the app.
#   lithocms_owner  owns the schema, runs migrations
#   lithocms_app    runtime role: not owner, no BYPASSRLS, so row-level security always applies
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v owner_pw="$LITHO_DB_OWNER_PASSWORD" \
  -v app_pw="$LITHO_DB_APP_PASSWORD" <<'SQL'
CREATE ROLE lithocms_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'owner_pw';
CREATE ROLE lithocms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_pw';

ALTER DATABASE :"db" OWNER TO lithocms_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO lithocms_app;

ALTER SCHEMA public OWNER TO lithocms_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lithocms_app;

-- Every table/sequence the owner creates in a migration is usable by the runtime role.
-- Append-only tables (audit_log) revoke UPDATE/DELETE in their own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE lithocms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lithocms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE lithocms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lithocms_app;
SQL
