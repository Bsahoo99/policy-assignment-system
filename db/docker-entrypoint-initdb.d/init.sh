#!/bin/bash
# Apply the base schema, then every migration in filename order.
#
# This was a static list of \i lines, and it drifted: migration 006 was added and
# this file was not, so the documented Docker path built a schema without
# assignment_rules.target_type and every rule write failed with 42703. The
# TypeScript callers were centralised on a directory read at the same time; this
# file was missed because it is psql, not TypeScript. A loop cannot drift.
#
# Postgres runs this once, on an empty data volume. An existing volume keeps its
# old schema -- see assertSchemaCurrent in src/runtime.ts, which says so at
# startup rather than letting the first write fail with a bare SQL error.
set -euo pipefail

DIR=/docker-entrypoint-initdb.d/db
run() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$1"; }

echo "applying schema.sql"
run "$DIR/schema.sql"

for f in "$DIR"/migrations/*.sql; do
  echo "applying migrations/$(basename "$f")"
  run "$f"
done
