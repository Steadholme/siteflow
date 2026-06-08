import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { migrations, runMigrations } from "./migrations";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

interface QueryResultLike {
  rows: unknown[];
  rowCount: number | null;
}

function checksumFor(sql: string) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function checksumForVersion(version: string) {
  const migration = migrations.find((entry) => entry.version === version);

  if (!migration) {
    throw new Error(`Unknown migration: ${version}`);
  }

  return checksumFor(migration.sql);
}

function successfulResult(result: Partial<QueryResultLike> = {}): QueryResultLike {
  return {
    rows: [],
    rowCount: 0,
    ...result
  };
}

function createMockPool(
  resultFor: (text: string, values?: unknown[]) => Partial<QueryResultLike> | Promise<Partial<QueryResultLike>>
) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return successfulResult(await resultFor(text, values));
    }),
    release: vi.fn()
  };
  const pool = {
    connect: vi.fn(async () => client)
  };

  return {
    client,
    pool: pool as unknown as Pool,
    queries
  };
}

function isAppliedMigrationQuery(text: string) {
  return text.includes("SELECT checksum_sha256 FROM siteflow_schema_migrations");
}

function appliedMigrationResult(version: string, checksum = checksumForVersion(version)) {
  return {
    rows: [{ checksum_sha256: checksum }],
    rowCount: 1
  };
}

describe("runMigrations", () => {
  it("defines hashed operator session storage", () => {
    const migration = migrations.find((entry) => entry.version === "020_operator_sessions");

    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS siteflow_operator_sessions");
    expect(migration?.sql).toContain("token_hash text NOT NULL UNIQUE");
    expect(migration?.sql).toContain("token_prefix text NOT NULL");
    expect(migration?.sql).toContain("expires_at timestamptz NOT NULL");
    expect(migration?.sql).toContain("idx_siteflow_operator_sessions_status_expires");
    expect(migration?.sql).toContain("scopes <@ ARRAY['read', 'write', 'admin']::text[]");
  });

  it("adds project scope metadata to operator sessions", () => {
    const migration = migrations.find((entry) => entry.version === "021_operator_session_project_scope");

    expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS project_ids text[]");
    expect(migration?.sql).toContain("siteflow_operator_sessions_project_ids_non_empty");
    expect(migration?.sql).toContain("array_position(project_ids, '') IS NULL");
    expect(migration?.sql).toContain("USING GIN (project_ids)");
  });

  it("defines operator session cutoff evidence storage", () => {
    const migration = migrations.find((entry) => entry.version === "022_operator_session_cutoffs");

    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS siteflow_operator_session_cutoffs");
    expect(migration?.sql).toContain("id text PRIMARY KEY");
    expect(migration?.sql).toContain("project_id text");
    expect(migration?.sql).toContain("actor jsonb");
    expect(migration?.sql).toContain("revoked_count integer NOT NULL CHECK (revoked_count >= 0)");
    expect(migration?.sql).toContain("created_at timestamptz NOT NULL DEFAULT now()");
    expect(migration?.sql).toContain("idx_siteflow_operator_session_cutoffs_created_at");
    expect(migration?.sql).toContain("idx_siteflow_operator_session_cutoffs_project_created_at");
    expect(migration?.sql).toContain("WHERE project_id IS NOT NULL");
  });

  it("adds release evidence lineage storage", () => {
    const migration = migrations.find((entry) => entry.version === "023_release_evidence_lineage");

    expect(migration?.sql).toContain("ALTER TABLE siteflow_release_commands");
    expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS release_evidence jsonb");
    expect(migration?.sql).toContain("ALTER TABLE siteflow_route_revisions");
  });

  it("takes an advisory transaction lock before checking migration state", async () => {
    const { client, pool, queries } = createMockPool((text, values) => {
      if (isAppliedMigrationQuery(text)) {
        return appliedMigrationResult(String(values?.[0]));
      }

      return {};
    });

    await runMigrations(pool);

    expect(queries[0].text).toBe("BEGIN");
    expect(queries[1].text).toBe("SELECT pg_advisory_xact_lock($1::integer, $2::integer)");
    expect(queries[1].values).toEqual([expect.any(Number), expect.any(Number)]);
    expect(queries[2].text).toContain("CREATE TABLE IF NOT EXISTS siteflow_schema_migrations");
    expect(queries[3].text).toContain("ADD COLUMN IF NOT EXISTS checksum_sha256 text");
    expect(queries.at(-1)?.text).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("inserts a checksum when applying a new migration", async () => {
    const target = migrations[0];
    const { pool, queries } = createMockPool((text, values) => {
      if (isAppliedMigrationQuery(text)) {
        const version = String(values?.[0]);

        if (version === target.version) {
          return { rows: [], rowCount: 0 };
        }

        return appliedMigrationResult(version);
      }

      return {};
    });

    await runMigrations(pool);

    const insert = queries.find((query) => query.text.includes("INSERT INTO siteflow_schema_migrations"));

    expect(queries.some((query) => query.text === target.sql)).toBe(true);
    expect(insert?.text).toContain("(version, checksum_sha256)");
    expect(insert?.values).toEqual([target.version, checksumFor(target.sql)]);
  });

  it("backfills checksums for legacy applied migrations", async () => {
    const target = migrations[1];
    const { pool, queries } = createMockPool((text, values) => {
      if (isAppliedMigrationQuery(text)) {
        const version = String(values?.[0]);

        if (version === target.version) {
          return {
            rows: [{ checksum_sha256: null }],
            rowCount: 1
          };
        }

        return appliedMigrationResult(version);
      }

      return {};
    });

    await runMigrations(pool);

    const backfill = queries.find((query) => query.text.includes("UPDATE siteflow_schema_migrations SET checksum_sha256"));

    expect(queries.some((query) => query.text === target.sql)).toBe(false);
    expect(backfill?.text).toContain("checksum_sha256 IS NULL OR checksum_sha256 = ''");
    expect(backfill?.values).toEqual([target.version, checksumFor(target.sql)]);
  });

  it("throws a drift error when an applied checksum differs", async () => {
    const target = migrations[2];
    const { client, pool, queries } = createMockPool((text, values) => {
      if (isAppliedMigrationQuery(text)) {
        const version = String(values?.[0]);

        if (version === target.version) {
          return appliedMigrationResult(version, "different-checksum");
        }

        return appliedMigrationResult(version);
      }

      return {};
    });

    await expect(runMigrations(pool)).rejects.toThrow(`Migration drift detected for ${target.version}`);

    expect(queries.some((query) => query.text === "ROLLBACK")).toBe(true);
    expect(queries.some((query) => query.text === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back when a migration statement fails", async () => {
    const target = migrations[0];
    const { client, pool, queries } = createMockPool((text, values) => {
      if (text === target.sql) {
        throw new Error("migration failed");
      }

      if (isAppliedMigrationQuery(text)) {
        const version = String(values?.[0]);

        if (version === target.version) {
          return { rows: [], rowCount: 0 };
        }

        return appliedMigrationResult(version);
      }

      return {};
    });

    await expect(runMigrations(pool)).rejects.toThrow("migration failed");

    expect(queries.some((query) => query.text === "ROLLBACK")).toBe(true);
    expect(queries.some((query) => query.text === "COMMIT")).toBe(false);
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_schema_migrations"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
