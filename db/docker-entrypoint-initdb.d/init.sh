#!/bin/bash
# Apply the base schema, then every migration in filename order, recording each
# in schema_migrations.
#
# Two things this file has been wrong about before:
#
#  1. It was a static list of \i lines and drifted -- migration 006 was added and
#     this was not, so the Docker path built a schema without
#     assignment_rules.target_type and every rule write failed with 42703.
#     A loop cannot drift.
#  2. The migration and its ledger row ran as two psql invocations, so an
#     interruption between them left the schema ahead of the ledger. These
#     migrations are not idempotent, so the next startup would try to re-apply
#     and fail. Each migration and its ledger row now run in ONE psql session
#     under --single-transaction, matching ensureSchema() in src/schema-sql.ts.
#
# Postgres runs this once, against an empty data volume. An existing volume keeps
# whatever it has; ensureSchema() then applies whatever schema_migrations does
# not already name.
set -euo pipefail

DIR=/docker-entrypoint-initdb.d/db
psql_run() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"; }

echo "applying schema.sql"
psql_run --single-transaction -f "$DIR/schema.sql"

for f in "$DIR"/migrations/*.sql; do
  name=$(basename "$f")
  echo "applying migrations/$name"
  # -f and -c run in the order given, inside one transaction, in one session.
  psql_run --single-transaction \
    -f "$f" \
    -c "INSERT INTO schema_migrations (name) VALUES ('$name')"
done
