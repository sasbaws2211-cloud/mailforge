#!/bin/bash
# docker/initdb/01-seed-test-db.sh
#
# Postgres initdb script: runs on first container initialization only
# (when the data volume is empty). Creates the claros_seed_test database
# and applies all community schema migrations to it.
#
# Schema source: /docker-entrypoint-initdb.d/migrations/*.sql
# These are mounted from drizzle/migrations/ via docker-compose volume.
# Single source of truth - no copied DDL.
#
# After applying SQL files, we also record each migration in
# drizzle.__drizzle_migrations so that check-migrations.sh and drizzle-kit
# recognize the database as up-to-date. Without this, the tracking table
# reports 0 applied while the schema is actually current.
#
# When migrations change: docker compose down -v && docker compose up -d
# (destroys and reinitializes the data volume).

set -e

echo "[initdb] Creating claros_seed_test database..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE claros_seed_test OWNER $POSTGRES_USER;
EOSQL

echo "[initdb] Applying migrations to claros_seed_test..."
for f in /docker-entrypoint-initdb.d/migrations/*.sql; do
    if [ -f "$f" ]; then
        echo "[initdb]   Applying $(basename "$f")..."
        # Strip drizzle-kit's --> statement-breakpoint comments before applying
        sed 's/--> statement-breakpoint//g' "$f" | \
            psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "claros_seed_test"
    fi
done

# Record applied migrations in drizzle's tracking table so that drizzle-kit
# and check-migrations.sh recognize the database as current. The drizzle schema
# and tracking table are created by the drizzle-orm migrator at runtime - they
# are NOT present in any .sql migration file - so we create them explicitly here.
echo "[initdb] Creating drizzle.__drizzle_migrations tracking table..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "claros_seed_test" <<-EOSQL
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
    );
EOSQL

echo "[initdb] Recording migrations in drizzle.__drizzle_migrations..."
MIGRATION_IDX=0
for f in /docker-entrypoint-initdb.d/migrations/*.sql; do
    if [ -f "$f" ]; then
        HASH=$(sha256sum "$f" | cut -d' ' -f1)
        CREATED_AT=$(date +%s%3N)
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "claros_seed_test" \
            -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$HASH', $CREATED_AT);"
        MIGRATION_IDX=$((MIGRATION_IDX + 1))
    fi
done

echo "[initdb] claros_seed_test ready ($MIGRATION_IDX migrations recorded)."
