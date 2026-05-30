import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

import { sqlite } from "./drizzle";

const LEGACY_LOCKED_LIST_MIGRATION = 1777464072036;

type MigrationRow = {
  created_at: number | null;
};

type TableInfoRow = {
  name: string;
};

function hasColumn(table: string, column: string) {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all() as TableInfoRow[];
  return rows.some((row) => row.name === column);
}

function getDuplicateColumnName(error: unknown) {
  if (!(error instanceof Error)) {
    return null;
  }

  return (
    error.message.match(/duplicate column name: ([`"\w]+)/)?.[1]?.replace(/[`"]/g, "") ??
    null
  );
}

function shouldSkipLegacyLockedListColumn(
  migration: MigrationMeta,
  statement: string,
  error: unknown,
) {
  if (migration.folderMillis !== LEGACY_LOCKED_LIST_MIGRATION) {
    return false;
  }

  const duplicateColumn = getDuplicateColumnName(error);
  if (!duplicateColumn) {
    return false;
  }

  if (
    duplicateColumn === "locked" &&
    /ALTER TABLE [`"]?bookmarkLists[`"]? ADD [`"]?locked[`"]?/.test(statement)
  ) {
    return hasColumn("bookmarkLists", "locked");
  }

  if (
    duplicateColumn === "passwordHash" &&
    /ALTER TABLE [`"]?bookmarkLists[`"]? ADD [`"]?passwordHash[`"]?/.test(statement)
  ) {
    return hasColumn("bookmarkLists", "passwordHash");
  }

  return false;
}

function ensureMigrationsTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
}

function getLastMigrationCreatedAt() {
  const row = sqlite
    .prepare(
      'SELECT "created_at" FROM "__drizzle_migrations" ORDER BY "created_at" DESC LIMIT 1',
    )
    .get() as MigrationRow | undefined;

  return row?.created_at ?? 0;
}

function runMigration(migration: MigrationMeta) {
  for (const statement of migration.sql) {
    const trimmedStatement = statement.trim();
    if (!trimmedStatement) {
      continue;
    }

    try {
      sqlite.exec(trimmedStatement);
    } catch (error) {
      if (shouldSkipLegacyLockedListColumn(migration, trimmedStatement, error)) {
        continue;
      }

      throw error;
    }
  }

  sqlite
    .prepare(
      'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
    )
    .run(migration.hash, migration.folderMillis);
}

const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });

ensureMigrationsTable();

const lastMigrationCreatedAt = getLastMigrationCreatedAt();
const pendingMigrations = migrations.filter(
  (migration) => migration.folderMillis > lastMigrationCreatedAt,
);

if (pendingMigrations.length > 0) {
  sqlite.exec("BEGIN");
  try {
    for (const migration of pendingMigrations) {
      runMigration(migration);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
