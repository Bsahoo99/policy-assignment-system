#!/bin/bash
# Apply the base schema, then every migration in filename order, recording each
# in schema_migrations so the application does not try to apply them again.
#
# This was a static list of \i lines and it drifted: migration 006 was added and
# this file was not, so the documented Docker path built a schema without
# assignment_rules.target_type and every rule write failed with 42703. A loop
# cannot drift.
#
# Postgres runs this once, against an empty data volume. An existing volume keeps
# whatever it has -- ensureSchema() in src/schema-sql.ts then applies whatever
# schema_migrations does not already name, on both backends.
set -euo pipefail

DIR=/docker-entrypoint-initdb.d/db
psql_run() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"; }

echo "applying schema.sql"
psql_run -f "$DIR/schema.sql"

for f in "$DIR"/migrations/*.sql; do
  name=$(basename "$f")
  echo "applying migrations/$name"
  psql_run -f "$f"
  psql_run -c "INSERT INTO schema_migrations (name) VALUES ('$name') ON CONFLICT DO NOTHING"
done
