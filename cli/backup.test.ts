import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSiteFlowBackup,
  fetchSiteFlowBackup,
  offloadSiteFlowBackup,
  pruneSiteFlowBackups,
  restoreDrillSiteFlowBackup,
  restoreSiteFlowBackup,
  verifySiteFlowBackup
} from "./backup";
import type { SiteFlowCommandRunner } from "./doctor";

const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow";

async function writeValidBackupManifest(
  backupPath: string,
  artifactPath: string | null = "artifacts",
  copied = true,
  createdAt = "2026-06-07T00:00:00.000Z",
  sourcePath = "/var/lib/siteflow/artifacts"
) {
  await writeFile(
    path.join(backupPath, "manifest.json"),
    `${JSON.stringify({
      version: "0.1.0-test",
      createdAt,
      database: {
        dumpFile: "database/siteflow.sql",
        format: "plain"
      },
      artifacts: {
        sourcePath,
        path: artifactPath,
        copied
      }
    })}\n`,
    "utf8"
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactTreeSha256(files: Array<{ relativePath: string; contents: string }>) {
  const checksum = createHash("sha256");

  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(file.contents);
  }

  return checksum.digest("hex");
}

async function writeBackupFixture(backupPath: string, createdAt = "2026-06-07T00:00:00.000Z") {
  await mkdir(path.join(backupPath, "database"), { recursive: true });
  await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
  await writeFile(path.join(backupPath, "database", "siteflow.sql"), `database dump ${createdAt}\n`, "utf8");
  await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), `<h1>${createdAt}</h1>`, "utf8");
  await writeValidBackupManifest(backupPath, "artifacts", true, createdAt);
}

async function s3RecursiveListingForDirectory(rootPath: string) {
  const files: Array<{ relativePath: string; size: number }> = [];

  async function collect(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile()) {
        files.push({
          relativePath: path.relative(rootPath, entryPath).replaceAll("\\", "/"),
          size: (await stat(entryPath)).size
        });
      }
    }
  }

  await collect(rootPath);

  return files
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => `2026-06-07 01:00:00 ${file.size.toString().padStart(10, " ")} ${file.relativePath}`)
    .join("\n");
}

async function directoryTreeIntegrity(rootPath: string) {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];

  async function collect(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile()) {
        files.push({
          relativePath: path.relative(rootPath, entryPath).replaceAll("\\", "/"),
          bytes: await readFile(entryPath)
        });
      }
    }
  }

  await collect(rootPath);

  const checksum = createHash("sha256");
  let totalBytes = 0;

  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(file.bytes);
    totalBytes += file.bytes.byteLength;
  }

  return {
    treeSha256: checksum.digest("hex"),
    fileCount: files.length,
    totalBytes
  };
}

describe("backup and restore operations", () => {
  it("creates a manifest, runs pg_dump, and copies artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-"));
    const artifactRoot = path.join(root, "artifacts-source");
    const backupPath = path.join(root, "backup");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });
      await writeFile(args[args.indexOf("--file") + 1], "database dump\n", "utf8");

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(artifactRoot, "project-a"), { recursive: true });
      await writeFile(path.join(artifactRoot, "project-a", "index.html"), "<h1>SiteFlow</h1>", "utf8");

      const result = await createSiteFlowBackup(
        {
          output: backupPath,
          databaseUrl,
          artifactRoot,
          version: "0.1.0-test"
        },
        {
          runner,
          now: () => new Date("2026-06-07T00:00:00.000Z")
        }
      );
      const manifest = JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8"));
      const artifactChecksum = artifactTreeSha256([
        {
          relativePath: "project-a/index.html",
          contents: "<h1>SiteFlow</h1>"
        }
      ]);

      expect(result).toMatchObject({
        status: "backed_up",
        backupPath,
        createdAt: "2026-06-07T00:00:00.000Z",
        version: "0.1.0-test",
        artifacts: {
          copied: true
        }
      });
      expect(commands).toEqual([
        {
          command: "pg_dump",
          args: ["--dbname", databaseUrl, "--file", path.join(backupPath, "database", "siteflow.sql")]
        }
      ]);
      expect(manifest).toMatchObject({
        version: "0.1.0-test",
        createdAt: "2026-06-07T00:00:00.000Z",
        database: {
          dumpFile: "database/siteflow.sql",
          format: "plain",
          sha256: sha256("database dump\n"),
          sizeBytes: "database dump\n".length
        },
        artifacts: {
          sourcePath: artifactRoot,
          path: "artifacts",
          copied: true,
          treeSha256: artifactChecksum,
          fileCount: 1,
          totalBytes: "<h1>SiteFlow</h1>".length
        }
      });
      expect(await readFile(path.join(backupPath, "database", "siteflow.sql"), "utf8")).toBe("database dump\n");
      expect(await readFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "utf8")).toBe("<h1>SiteFlow</h1>");

      const verification = await verifySiteFlowBackup({ backup: backupPath });

      expect(verification.database).toMatchObject({
        sha256: sha256("database dump\n"),
        checksumVerified: true
      });
      expect(verification.artifacts).toMatchObject({
        treeSha256: artifactChecksum,
        checksumVerified: true,
        fileCount: 1,
        totalBytes: "<h1>SiteFlow</h1>".length
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("statically verifies a valid backup manifest, dump, and artifact directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-verify-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "<h1>Verified</h1>", "utf8");
      await writeValidBackupManifest(backupPath);

      const result = await verifySiteFlowBackup({
        backup: backupPath
      });

      expect(result).toMatchObject({
        status: "verified",
        backupPath,
        version: "0.1.0-test",
        verificationType: "static",
        restoreDrill: false,
        database: {
          format: "plain",
          sizeBytes: "database dump\n".length
        },
        artifacts: {
          copied: true,
          present: true
        }
      });
      expect(result.note).toContain("no database restore was performed");
      expect(result.checks.map((check) => check.name)).toEqual([
        "manifest",
        "database_dump",
        "artifacts",
        "restore_scope"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("offloads a verified backup to a file target and verifies the copied tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-offload-"));
    const backupPath = path.join(root, "backups", "siteflow-20260607");
    const offHostRoot = path.join(root, "offhost");

    try {
      await writeBackupFixture(backupPath);

      const result = await offloadSiteFlowBackup(
        {
          backup: backupPath,
          target: pathToFileURL(offHostRoot).href
        },
        {
          now: () => new Date("2026-06-07T01:00:00.000Z")
        }
      );
      const offloadedBackupPath = path.join(offHostRoot, "siteflow-20260607");

      expect(result).toMatchObject({
        status: "offloaded",
        backupPath,
        offloadedAt: "2026-06-07T01:00:00.000Z",
        target: {
          provider: "file",
          path: offloadedBackupPath,
          checksumVerified: true
        }
      });
      expect(result.target.location).toBe(pathToFileURL(offloadedBackupPath).href);
      expect(result.target.treeSha256).toBe(result.source.treeSha256);
      expect(result.target.objectCount).toBe(result.source.objectCount);
      expect(result.target.totalBytes).toBe(result.source.totalBytes);
      expect(await readFile(path.join(offloadedBackupPath, "database", "siteflow.sql"), "utf8")).toBe("database dump 2026-06-07T00:00:00.000Z\n");
      expect(await readFile(path.join(offloadedBackupPath, "artifacts", "project-a", "index.html"), "utf8")).toBe("<h1>2026-06-07T00:00:00.000Z</h1>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("offloads a verified backup to S3 and records production off-host evidence metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-offload-s3-"));
    const backupPath = path.join(root, "backups", "siteflow-20260607");
    const commands: Array<{ command: string; args: string[] }> = [];
    let uploaded = false;
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      if (command === "aws" && args[0] === "s3" && args[1] === "cp") {
        uploaded = true;

        return { exitCode: 0, stdout: "", stderr: "" };
      }

      if (command === "aws" && args[0] === "s3" && args[1] === "ls") {
        return {
          exitCode: 0,
          stdout: uploaded ? await s3RecursiveListingForDirectory(backupPath) : "",
          stderr: ""
        };
      }

      if (command === "aws" && args[0] === "s3api" && args[1] === "head-object") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
            ObjectLockMode: "COMPLIANCE",
            ObjectLockRetainUntilDate: "2026-07-08T01:00:00.000Z"
          }),
          stderr: ""
        };
      }

      if (command === "aws" && args[0] === "s3api" && args[1] === "get-object-lock-configuration") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ObjectLockConfiguration: {
              ObjectLockEnabled: "Enabled",
              Rule: {
                DefaultRetention: {
                  Mode: "COMPLIANCE",
                  Days: 30
                }
              }
            }
          }),
          stderr: ""
        };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    try {
      await writeBackupFixture(backupPath);

      const result = await offloadSiteFlowBackup(
        {
          backup: backupPath,
          target: "s3://siteflow-prod-backups/backups",
          kmsKeyRef: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
          providerRetentionMode: "compliance",
          providerRetentionDays: 30,
          providerRetentionContract: "s3-object-lock-siteflow-prod",
          verifyProviderConfig: true
        },
        {
          runner,
          now: () => new Date("2026-06-07T01:00:00.000Z")
        }
      );

      expect(commands).toHaveLength(5);
      expect(commands[0]).toMatchObject({
        command: "aws",
        args: ["s3", "ls", "s3://siteflow-prod-backups/backups/siteflow-20260607/", "--recursive"]
      });
      expect(commands[1]).toMatchObject({
        command: "aws",
        args: [
          "s3",
          "cp",
          backupPath,
          "s3://siteflow-prod-backups/backups/siteflow-20260607/",
          "--recursive",
          "--only-show-errors",
          "--sse",
          "aws:kms",
          "--sse-kms-key-id",
          "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups"
        ]
      });
      expect(commands[2]).toMatchObject({
        command: "aws",
        args: ["s3", "ls", "s3://siteflow-prod-backups/backups/siteflow-20260607/", "--recursive"]
      });
      expect(commands[3]).toMatchObject({
        command: "aws",
        args: ["s3api", "head-object", "--bucket", "siteflow-prod-backups", "--key", "backups/siteflow-20260607/manifest.json", "--output", "json"]
      });
      expect(commands[4]).toMatchObject({
        command: "aws",
        args: ["s3api", "get-object-lock-configuration", "--bucket", "siteflow-prod-backups", "--output", "json"]
      });
      expect(result).toMatchObject({
        status: "offloaded",
        backupPath,
        offloadedAt: "2026-06-07T01:00:00.000Z",
        target: {
          provider: "s3",
          location: "s3://siteflow-prod-backups/backups/siteflow-20260607",
          checksumVerified: true,
          encryption: {
            mode: "kms",
            kmsKeyRef: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
            evidenceSource: "aws_s3api"
          },
          providerRetention: {
            status: "enabled",
            mode: "compliance",
            retentionDays: 30,
            contractId: "s3-object-lock-siteflow-prod",
            evidenceSource: "aws_s3api"
          },
          providerProof: {
            status: "verified",
            provider: "aws_s3",
            bucket: "siteflow-prod-backups",
            prefix: "backups/siteflow-20260607",
            sampleObjectKey: "backups/siteflow-20260607/manifest.json",
            object: {
              serverSideEncryption: "aws:kms",
              objectLockMode: "COMPLIANCE"
            },
            bucketObjectLock: {
              objectLockEnabled: true,
              defaultRetentionMode: "COMPLIANCE",
              defaultRetentionDays: 30
            },
            evidenceSource: "provider_api"
          }
        }
      });
      expect(result.target.treeSha256).toBe(result.source.treeSha256);
      expect(result.target.objectCount).toBe(result.source.objectCount);
      expect(result.target.totalBytes).toBe(result.source.totalBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches a backup from S3 and verifies expected off-host integrity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-fetch-s3-"));
    const remoteBackupPath = path.join(root, "remote", "siteflow-20260607");
    const outputRoot = path.join(root, "fetched");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      if (command === "aws" && args[0] === "s3" && args[1] === "ls") {
        return {
          exitCode: 0,
          stdout: await s3RecursiveListingForDirectory(remoteBackupPath),
          stderr: ""
        };
      }

      if (command === "aws" && args[0] === "s3" && args[1] === "cp") {
        await cp(remoteBackupPath, args[3], { recursive: true });

        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    try {
      await writeBackupFixture(remoteBackupPath);
      const expectedIntegrity = await directoryTreeIntegrity(remoteBackupPath);
      const result = await fetchSiteFlowBackup(
        {
          source: "s3://siteflow-prod-backups/backups/siteflow-20260607",
          output: outputRoot,
          expectedTreeSha256: expectedIntegrity.treeSha256,
          expectedObjectCount: expectedIntegrity.fileCount,
          expectedTotalBytes: expectedIntegrity.totalBytes
        },
        {
          runner,
          now: () => new Date("2026-06-07T02:00:00.000Z")
        }
      );

      expect(commands).toEqual([
        {
          command: "aws",
          args: ["s3", "ls", "s3://siteflow-prod-backups/backups/siteflow-20260607/", "--recursive"]
        },
        {
          command: "aws",
          args: [
            "s3",
            "cp",
            "s3://siteflow-prod-backups/backups/siteflow-20260607/",
            path.join(outputRoot, "siteflow-20260607"),
            "--recursive",
            "--only-show-errors"
          ]
        }
      ]);
      expect(result).toMatchObject({
        status: "fetched",
        source: {
          provider: "s3",
          location: "s3://siteflow-prod-backups/backups/siteflow-20260607",
          objectCount: expectedIntegrity.fileCount,
          totalBytes: expectedIntegrity.totalBytes,
          treeSha256: expectedIntegrity.treeSha256
        },
        backupPath: path.join(outputRoot, "siteflow-20260607"),
        fetchedAt: "2026-06-07T02:00:00.000Z",
        checksumVerified: true,
        verifyResult: {
          status: "verified",
          version: "0.1.0-test"
        }
      });
      expect(result.treeSha256).toBe(expectedIntegrity.treeSha256);
      expect(result.objectCount).toBe(expectedIntegrity.fileCount);
      expect(result.totalBytes).toBe(expectedIntegrity.totalBytes);
      expect(await readFile(path.join(result.backupPath, "database", "siteflow.sql"), "utf8")).toBe("database dump 2026-06-07T00:00:00.000Z\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects S3 backup fetches when remote object counts do not match expected evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-fetch-s3-mismatch-"));
    const remoteBackupPath = path.join(root, "remote", "siteflow-20260607");
    const runner: SiteFlowCommandRunner = async (command, args) => {
      if (command === "aws" && args[0] === "s3" && args[1] === "ls") {
        return {
          exitCode: 0,
          stdout: await s3RecursiveListingForDirectory(remoteBackupPath),
          stderr: ""
        };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    try {
      await writeBackupFixture(remoteBackupPath);
      const expectedIntegrity = await directoryTreeIntegrity(remoteBackupPath);

      await expect(
        fetchSiteFlowBackup(
          {
            source: "s3://siteflow-prod-backups/backups/siteflow-20260607",
            output: path.join(root, "fetched"),
            expectedTreeSha256: expectedIntegrity.treeSha256,
            expectedObjectCount: expectedIntegrity.fileCount + 1,
            expectedTotalBytes: expectedIntegrity.totalBytes
          },
          { runner }
        )
      ).rejects.toThrow("Backup S3 fetch remote object verification failed.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects S3 backup fetches when the destination backup already exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-fetch-s3-existing-"));
    let runnerCalled = false;

    try {
      await mkdir(path.join(root, "fetched", "siteflow-20260607"), { recursive: true });

      await expect(
        fetchSiteFlowBackup(
          {
            source: "s3://siteflow-prod-backups/backups/siteflow-20260607",
            output: path.join(root, "fetched"),
            expectedTreeSha256: sha256("placeholder"),
            expectedObjectCount: 1,
            expectedTotalBytes: 1
          },
          {
            runner: async () => {
              runnerCalled = true;

              return { exitCode: 0, stdout: "", stderr: "" };
            }
          }
        )
      ).rejects.toThrow("Backup fetch destination already exists.");
      expect(runnerCalled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects offload targets inside the source backup directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-offload-inside-"));
    const backupPath = path.join(root, "backup");

    try {
      await writeBackupFixture(backupPath);

      await expect(
        offloadSiteFlowBackup({
          backup: backupPath,
          target: pathToFileURL(path.join(backupPath, "nested-offload")).href
        })
      ).rejects.toThrow("must not be inside the source backup directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans backup pruning without deleting candidates during dry-run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-prune-dry-run-"));
    const backupRoot = path.join(root, "backups");
    const oldBackup = path.join(backupRoot, "siteflow-old-a");

    try {
      await writeBackupFixture(oldBackup, "2026-01-01T00:00:00.000Z");
      await writeBackupFixture(path.join(backupRoot, "siteflow-old-b"), "2026-01-02T00:00:00.000Z");
      await writeBackupFixture(path.join(backupRoot, "siteflow-current"), "2026-06-07T00:00:00.000Z");

      const result = await pruneSiteFlowBackups(
        {
          backupRoot,
          retentionDays: 30,
          minimumBackups: 2,
          dryRun: true
        },
        {
          now: () => new Date("2026-06-07T12:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "planned",
        backupRoot,
        dryRun: true,
        evaluatedBackups: 3
      });
      expect(result.candidates.map((backup) => path.basename(backup.backupPath))).toEqual(["siteflow-old-a"]);
      expect(result.deleted).toEqual([]);
      expect(result.retained).toHaveLength(3);
      expect(await readFile(path.join(oldBackup, "manifest.json"), "utf8")).toContain("2026-01-01T00:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes old backups only after explicit confirmation while keeping the minimum backup count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-prune-confirmed-"));
    const backupRoot = path.join(root, "backups");
    const oldBackup = path.join(backupRoot, "siteflow-old-a");
    const retainedOldBackup = path.join(backupRoot, "siteflow-old-b");
    const currentBackup = path.join(backupRoot, "siteflow-current");

    try {
      await writeBackupFixture(oldBackup, "2026-01-01T00:00:00.000Z");
      await writeBackupFixture(retainedOldBackup, "2026-01-02T00:00:00.000Z");
      await writeBackupFixture(currentBackup, "2026-06-07T00:00:00.000Z");

      const result = await pruneSiteFlowBackups(
        {
          backupRoot,
          retentionDays: 30,
          minimumBackups: 2,
          yes: true
        },
        {
          now: () => new Date("2026-06-07T12:00:00.000Z")
        }
      );

      expect(result.status).toBe("pruned");
      expect(result.deleted.map((backup) => path.basename(backup.backupPath))).toEqual(["siteflow-old-a"]);
      expect(result.retained.map((backup) => path.basename(backup.backupPath))).toEqual([
        "siteflow-current",
        "siteflow-old-b"
      ]);
      await expect(readFile(path.join(oldBackup, "manifest.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await readFile(path.join(retainedOldBackup, "manifest.json"), "utf8")).toContain("2026-01-02T00:00:00.000Z");
      expect(await readFile(path.join(currentBackup, "manifest.json"), "utf8")).toContain("2026-06-07T00:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks destructive backup pruning without --yes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-prune-no-confirm-"));
    const backupRoot = path.join(root, "backups");

    try {
      await writeBackupFixture(path.join(backupRoot, "siteflow-old-a"), "2026-01-01T00:00:00.000Z");

      await expect(
        pruneSiteFlowBackups({
          backupRoot,
          retentionDays: 30,
          minimumBackups: 1
        })
      ).rejects.toThrow("requires --yes unless --dry-run is set");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty backup dump during static verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-empty-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "", "utf8");
      await writeValidBackupManifest(backupPath, null, false);

      await expect(
        verifySiteFlowBackup({
          backup: backupPath
        })
      ).rejects.toThrow("dump file is empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe manifest paths during static verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-unsafe-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(backupPath, { recursive: true });
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "../siteflow.sql",
            format: "plain"
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: null,
            copied: false
          }
        })}\n`,
        "utf8"
      );

      await expect(
        verifySiteFlowBackup({
          backup: backupPath
        })
      ).rejects.toThrow("relative path inside the backup");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest that claims artifacts were copied when the artifact directory is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-missing-artifacts-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeValidBackupManifest(backupPath);

      await expect(
        verifySiteFlowBackup({
          backup: backupPath
        })
      ).rejects.toThrow("artifact directory is missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects backup dumps whose checksum no longer matches the manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-dump-checksum-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "tampered dump\n", "utf8");
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "database/siteflow.sql",
            format: "plain",
            sha256: sha256("original dump\n"),
            sizeBytes: "original dump\n".length
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: null,
            copied: false
          }
        })}\n`,
        "utf8"
      );

      await expect(
        verifySiteFlowBackup({
          backup: backupPath
        })
      ).rejects.toThrow("dump checksum does not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects backup artifacts whose tree checksum no longer matches the manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-artifact-checksum-"));
    const backupPath = path.join(root, "backup");

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "<h1>Tampered</h1>", "utf8");
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "database/siteflow.sql",
            format: "plain",
            sha256: sha256("database dump\n"),
            sizeBytes: "database dump\n".length
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: "artifacts",
            copied: true,
            treeSha256: artifactTreeSha256([
              {
                relativePath: "project-a/index.html",
                contents: "<h1>Original</h1>"
              }
            ]),
            fileCount: 1,
            totalBytes: "<h1>Original</h1>".length
          }
        })}\n`,
        "utf8"
      );

      await expect(
        verifySiteFlowBackup({
          backup: backupPath
        })
      ).rejects.toThrow("artifact tree checksum does not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the database and artifact directory from a manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-"));
    const backupPath = path.join(root, "backup");
    const artifactRoot = path.join(root, "restored-artifacts");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "<h1>Restored</h1>", "utf8");
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(artifactRoot, "stale.txt"), "stale", "utf8");
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "database/siteflow.sql",
            format: "plain"
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: "artifacts",
            copied: true
          }
        })}\n`,
        "utf8"
      );

      const result = await restoreSiteFlowBackup(
        {
          backup: backupPath,
          databaseUrl,
          artifactRoot
        },
        { runner }
      );

      expect(result).toMatchObject({
        status: "restored",
        backupPath,
        version: "0.1.0-test",
        database: {
          restoredWith: "psql"
        },
        artifacts: {
          copied: true,
          targetPath: artifactRoot
        }
      });
      expect(commands).toEqual([
        {
          command: "psql",
          args: [
            "--dbname",
            databaseUrl,
            "--set",
            "ON_ERROR_STOP=1",
            "--single-transaction",
            "--file",
            path.join(backupPath, "database", "siteflow.sql")
          ]
        }
      ]);
      await expect(readFile(path.join(artifactRoot, "stale.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await readFile(path.join(artifactRoot, "project-a", "index.html"), "utf8")).toBe("<h1>Restored</h1>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a restore drill through psql and reports disposable targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-drill-"));
    const backupPath = path.join(root, "backup");
    const artifactRoot = path.join(root, "drill-artifacts");
    const commands: Array<{ command: string; args: string[] }> = [];
    let nowCallCount = 0;
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "<h1>Drilled</h1>", "utf8");
      const artifactChecksum = artifactTreeSha256([
        {
          relativePath: "project-a/index.html",
          contents: "<h1>Drilled</h1>"
        }
      ]);
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "database/siteflow.sql",
            format: "plain",
            sha256: sha256("database dump\n"),
            sizeBytes: "database dump\n".length
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: "artifacts",
            copied: true,
            treeSha256: artifactChecksum,
            fileCount: 1,
            totalBytes: "<h1>Drilled</h1>".length
          }
        })}\n`,
        "utf8"
      );

      const result = await restoreDrillSiteFlowBackup(
        {
          backup: backupPath,
          databaseUrl,
          artifactRoot
        },
        {
          runner,
          now: () => new Date(nowCallCount++ === 0 ? "2026-06-07T00:00:00.000Z" : "2026-06-07T00:00:02.500Z")
        }
      );

      expect(result).toMatchObject({
        status: "restore_drilled",
        restoreDrill: true,
        backupPath,
        version: "0.1.0-test",
        durationMs: 2500,
        database: {
          dumpFile: path.join(backupPath, "database", "siteflow.sql"),
          restoredWith: "psql",
          target: "disposable_database",
          databaseUrl: "[redacted database url]"
        },
        artifacts: {
          target: "temporary_artifact_root",
          targetPath: artifactRoot,
          copied: true,
          restoreMode: "replace_non_atomic",
          treeSha256: artifactChecksum,
          fileCount: 1,
          totalBytes: "<h1>Drilled</h1>".length,
          checksumVerified: true
        }
      });
      expect(result.note).toContain("disposable targets");
      expect(commands).toEqual([
        {
          command: "psql",
          args: [
            "--dbname",
            databaseUrl,
            "--set",
            "ON_ERROR_STOP=1",
            "--single-transaction",
            "--file",
            path.join(backupPath, "database", "siteflow.sql")
          ]
        }
      ]);
      expect(await readFile(path.join(artifactRoot, "project-a", "index.html"), "utf8")).toBe("<h1>Drilled</h1>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run psql for a restore drill when static verification fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-drill-invalid-"));
    const backupPath = path.join(root, "backup");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeValidBackupManifest(backupPath);

      await expect(
        restoreDrillSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: path.join(root, "drill-artifacts")
          },
          { runner }
        )
      ).rejects.toThrow("artifact directory is missing");
      expect(commands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill database targets that match the source database canonical key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-drill-db-overlap-"));
    const backupPath = path.join(root, "backup");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeValidBackupManifest(backupPath);

      await expect(
        restoreDrillSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: path.join(root, "drill-artifacts"),
            sourceDatabaseUrl: "postgresql://siteflow:prodsecret@LOCALHOST/siteflow?sslmode=require"
          },
          { runner }
        )
      ).rejects.toThrow("Restore drill database URL must be isolated");
      expect(commands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill artifact targets that overlap the backup source artifact root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-drill-overlap-"));
    const backupPath = path.join(root, "backup");
    const sourceArtifactRoot = path.join(root, "source-artifacts");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeValidBackupManifest(backupPath, "artifacts", true, "2026-06-07T00:00:00.000Z", sourceArtifactRoot);

      await expect(
        restoreDrillSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: path.join(sourceArtifactRoot, "drill-target")
          },
          { runner }
        )
      ).rejects.toThrow("Restore drill artifact root must be isolated");
      expect(commands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill artifact targets that overlap the current artifact root before deleting files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-drill-current-overlap-"));
    const backupPath = path.join(root, "backup");
    const currentArtifactRoot = path.join(root, "current-artifacts");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await mkdir(path.join(backupPath, "artifacts"), { recursive: true });
      await mkdir(currentArtifactRoot, { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeFile(path.join(currentArtifactRoot, "keep.txt"), "production artifact\n", "utf8");
      await writeValidBackupManifest(backupPath);

      await expect(
        restoreDrillSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: currentArtifactRoot,
            currentArtifactRoot
          },
          { runner }
        )
      ).rejects.toThrow("Restore drill artifact root must be isolated from the current artifact root");
      expect(commands).toEqual([]);
      expect(await readFile(path.join(currentArtifactRoot, "keep.txt"), "utf8")).toBe("production artifact\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing restore artifacts before running psql", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-missing-artifacts-"));
    const backupPath = path.join(root, "backup");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push({ command, args });

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      await mkdir(path.join(backupPath, "database"), { recursive: true });
      await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
      await writeValidBackupManifest(backupPath);

      await expect(
        restoreSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: path.join(root, "artifacts")
          },
          { runner }
        )
      ).rejects.toThrow("artifact directory is missing");
      expect(commands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe manifest paths before running restore commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-restore-invalid-"));
    const backupPath = path.join(root, "backup");
    const runner: SiteFlowCommandRunner = async () => {
      throw new Error("runner should not be called");
    };

    try {
      await mkdir(backupPath, { recursive: true });
      await writeFile(
        path.join(backupPath, "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-06-07T00:00:00.000Z",
          database: {
            dumpFile: "../siteflow.sql",
            format: "plain"
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: null,
            copied: false
          }
        })}\n`,
        "utf8"
      );

      await expect(
        restoreSiteFlowBackup(
          {
            backup: backupPath,
            databaseUrl,
            artifactRoot: path.join(root, "artifacts")
          },
          { runner }
        )
      ).rejects.toThrow("relative path inside the backup");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts database URL secrets from command failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-redact-"));
    const runner: SiteFlowCommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `pg_dump failed for ${databaseUrl} password=supersecret`
    });

    try {
      let message = "";

      try {
        await createSiteFlowBackup(
          {
            output: path.join(root, "backup"),
            databaseUrl,
            artifactRoot: path.join(root, "artifacts"),
            version: "0.1.0-test"
          },
          { runner }
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("[redacted database url]");
      expect(message).not.toContain(databaseUrl);
      expect(message).not.toContain("supersecret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
