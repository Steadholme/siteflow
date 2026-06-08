import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseReleaseArtifactCheckArgs,
  runReleaseArtifactCheck,
  type ReleaseArtifactCommandRunner,
  type ReleaseArtifactManifest
} from "./releaseArtifactCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const releaseIdentity = {
  commitRef: "abc123def456",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production"
};

async function writeText(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeCleanArtifacts(root: string) {
  await writeText(root, "dist/index.html", "<div id=\"root\"></div>");
  await writeText(root, "dist/assets/index.js", "console.log('siteflow release artifact');");
  await writeText(root, "dist/assets/index.css", "body { margin: 0; }");
  await writeText(root, "dist-cli/cli/index.js", "#!/usr/bin/env node\nconsole.log('siteflow cli');");
  await writeText(root, "dist-server/server/index.js", "export const server = true;");
  await writeText(root, "dist-worker/worker/index.js", "export const worker = true;");
  await writeText(root, "package.json", JSON.stringify({
    name: "siteflow-console",
    private: true,
    engines: {
      node: ">=20.0.0"
    },
    bin: {
      siteflow: "./dist-cli/cli/index.js"
    },
    files: [
      "dist/",
      "dist-cli/",
      "dist-server/",
      "dist-worker/"
    ]
  }, null, 2));
  await writeText(root, "Dockerfile", [
    "FROM node:20-bookworm-slim AS build",
    "WORKDIR /app",
    "COPY package.json package-lock.json ./",
    "COPY scripts/releaseDependencyPolicyCheck.mjs ./scripts/releaseDependencyPolicyCheck.mjs",
    "RUN node scripts/releaseDependencyPolicyCheck.mjs --json",
    "RUN npm ci",
    "COPY . .",
    "RUN npm run build",
    "FROM node:20-bookworm-slim AS runtime",
    "RUN apt-get update && apt-get install -y --no-install-recommends docker.io git openssh-client",
    "COPY package.json package-lock.json ./",
    "COPY scripts/releaseDependencyPolicyCheck.mjs ./scripts/releaseDependencyPolicyCheck.mjs",
    "RUN node scripts/releaseDependencyPolicyCheck.mjs --json",
    "COPY --from=build /app/dist ./dist",
    "COPY --from=build /app/dist-cli ./dist-cli",
    "COPY --from=build /app/dist-server ./dist-server",
    "COPY --from=build /app/dist-worker ./dist-worker",
    "CMD [\"node\", \"dist-server/server/index.js\"]"
  ].join("\n"));
  await writeText(root, ".dockerignore", [
    "node_modules",
    "dist",
    "dist-cli",
    "dist-server",
    "dist-worker",
    ".env",
    "release-image-evidence*.json",
    "release-evidence*.json",
    "release-post-promotion-evidence*.json",
    "release-source-cleanup-plan*.json"
  ].join("\n"));
  await writeText(root, ".github/workflows/release-image.yml", [
    "name: Release Image",
    "jobs:",
    "  publish:",
    "    steps:",
    "      - run: npm run --silent release:dependency:policy -- --json",
    "      - uses: actions/upload-artifact@v4",
    "      - uses: docker/build-push-action@v6",
    "        id: build",
    "        with:",
    "          push: true",
    "          provenance: true",
    "          sbom: true",
    "          tags: ghcr.io/siteflow/siteflow:0.1.0",
    "      - run: echo '${{ steps.build.outputs.digest }}' > release-image-evidence.json",
    "      - run: echo release-image-evidence"
  ].join("\n"));
}

async function writeDeploymentArtifactManifest(root: string, manifest: Record<string, unknown> = { functions: [] }) {
  const relativePath = "deployment-artifact-manifest.json";

  await writeText(root, relativePath, JSON.stringify(manifest));
  return path.join(root, relativePath);
}

function cleanPackFiles() {
  return [
    "package.json",
    "dist/index.html",
    "dist/assets/index.js",
    "dist/assets/index.css",
    "dist-cli/cli/index.js",
    "dist-server/server/index.js",
    "dist-worker/worker/index.js"
  ];
}

function packOutput(files = cleanPackFiles()) {
  return JSON.stringify([
    {
      files: files.map((file, index) => ({
        path: file,
        size: index + 1,
        mode: file === "dist-cli/cli/index.js" ? 493 : 420
      }))
    }
  ]);
}

function dependencyPolicyOutput(status = "passed") {
  return JSON.stringify({
    name: "siteflow-release-dependency-policy-check",
    status,
    checks: status === "passed"
      ? [{ name: "dependency_manifest_lock_sync", status: "pass", message: "ok" }]
      : [{ name: "dependency_manifest_lock_sync", status: "fail", message: "blocked" }]
  });
}

function passingCommandRunner(files = cleanPackFiles()): ReleaseArtifactCommandRunner {
  return async (command) => {
    if (command.args.includes("pack")) {
      expect(command.args.slice(-4)).toEqual(["pack", "--dry-run", "--json", "--ignore-scripts"]);

      return {
        exitCode: 0,
        stdout: packOutput(files),
        stderr: ""
      };
    }

    if (command.args.some((arg) => arg.endsWith("releaseDependencyPolicyCheck.mjs"))) {
      return {
        exitCode: 0,
        stdout: dependencyPolicyOutput(),
        stderr: ""
      };
    }

    expect(command.args.slice(-4)).toEqual(["audit", "--omit=dev", "--audit-level=moderate", "--json"]);

    return {
      exitCode: 0,
      stdout: JSON.stringify({ vulnerabilities: {} }),
      stderr: ""
    };
  };
}

describe("releaseArtifactCheck", () => {
  it("passes clean release artifacts and writes a sha256 manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-clean-"));

    try {
      await writeCleanArtifacts(root);
      const deploymentArtifactManifestPath = await writeDeploymentArtifactManifest(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        manifestPath: "release-artifact-manifest.json",
        deploymentArtifactManifestPath,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const manifest = JSON.parse(await readFile(path.join(root, "release-artifact-manifest.json"), "utf8")) as ReleaseArtifactManifest;

      expect(result.status).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.selectedEvidence.fileCount).toBe(6);
      expect(result.selectedEvidence).toMatchObject({
        commitRef: "abc123def456",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      });
      expect(result.selectedEvidence.packageBinSiteflow).toBe("./dist-cli/cli/index.js");
      expect(result.selectedEvidence.installProfileStatus).toBe("passed");
      expect(result.selectedEvidence.dependencyPolicyStatus).toBe("passed");
      expect(result.artifactManifest).toEqual({ functions: [] });
      expect(result.checks.every((check) => check.status === "pass")).toBe(true);
      expect(manifest.schemaVersion).toBe("siteflow.releaseArtifactManifest.v1");
      expect(manifest.artifacts).toHaveLength(6);
      expect(manifest.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches a sanitized deployment artifact manifest from deployment detail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-deployment-detail-"));

    try {
      await writeCleanArtifacts(root);
      const deploymentDetailPath = await writeDeploymentArtifactManifest(root, {
        project: {
          repository: {
            owner: "acme",
            name: "siteflow"
          }
        },
        lineage: {
          sourceEvent: {
            commitSha: "abc123def456",
            branch: "main"
          },
          artifact: {
            manifest: {
              metadata: {
                sealedRuntimeEnv: {
                  API_KEY: "sealed-secret-value"
                }
              },
              functions: [
                {
                  path: "/api/revalidate",
                  sourcePath: ".siteflow/functions/api/revalidate.js",
                  runtime: "nodejs20.x",
                  runtimeIsolation: "isolated_process",
                  handler: "default",
                  ignoredSecret: "secret-like-value"
                }
              ]
            }
          },
          deployment: {
            environment: "production"
          }
        }
      });
      const sanitizedManifestPath = path.join(root, "evidence", "deployment-artifact-manifest.json");

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        deploymentDetailPath,
        writeDeploymentArtifactManifestPath: sanitizedManifestPath,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const sanitizedManifest = JSON.parse(await readFile(sanitizedManifestPath, "utf8"));

      expect(result.status).toBe("passed");
      expect(result.artifactManifest).toEqual({
        functions: [
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            runtimeIsolation: "isolated_process"
          }
        ]
      });
      expect(sanitizedManifest).toEqual(result.artifactManifest);
      expect(result.deploymentArtifactManifestPath).toBe(sanitizedManifestPath);
      expect(JSON.stringify(result.artifactManifest)).not.toContain("sealed-secret-value");
      expect(JSON.stringify(result.artifactManifest)).not.toContain("secret-like-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks deployment detail evidence that does not match the release identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-deployment-mismatch-"));

    try {
      await writeCleanArtifacts(root);
      const deploymentDetailPath = await writeDeploymentArtifactManifest(root, {
        project: {
          repository: {
            owner: "acme",
            name: "siteflow"
          }
        },
        deployment: {
          environment: "production"
        },
        lineage: {
          sourceEvent: {
            commitSha: "different-commit",
            branch: "main"
          },
          artifact: {
            manifest: {
              functions: []
            }
          }
        }
      });

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        deploymentDetailPath,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const manifestCheck = result.checks.find((check) => check.name === "deployment_artifact_manifest");

      expect(result.status).toBe("blocked");
      expect(manifestCheck).toMatchObject({
        status: "fail",
        message: expect.stringContaining("commitRef must be abc123def456")
      });
      expect(manifestCheck?.details?.deploymentIdentity).toMatchObject({
        commitRef: "different-commit",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks release artifact evidence without a deployment artifact manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-missing-deployment-manifest-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const manifestCheck = result.checks.find((check) => check.name === "deployment_artifact_manifest");

      expect(result.status).toBe("blocked");
      expect(manifestCheck).toMatchObject({
        status: "fail",
        message: expect.stringContaining("deployment artifact manifest")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require deployment artifact manifest for non-production artifact checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-ci-no-deployment-manifest-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        commitRef: "abc123def456",
        repo: "acme/siteflow",
        branch: "feature/check",
        targetEnvironment: "ci",
        now
      });
      const manifestCheck = result.checks.find((check) => check.name === "deployment_artifact_manifest");

      expect(result.status).toBe("passed");
      expect(manifestCheck).toMatchObject({
        status: "pass",
        message: expect.stringContaining("not required")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks artifacts containing fixture or secret canary evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-sensitive-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "dist/assets/index.js", "export const leaked = 'buildSecretEcho SITEFLOW_SECRET_CANARY_20260515';");

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const sensitiveCheck = result.checks.find((check) => check.name === "sensitive_artifact_scan");

      expect(result.status).toBe("blocked");
      expect(sensitiveCheck).toMatchObject({
        status: "fail",
        message: expect.stringContaining("sensitive artifact pattern")
      });
      expect(JSON.stringify(sensitiveCheck?.details)).toContain("dist/assets/index.js");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic credential patterns in release artifacts and npm pack files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-generic-secret-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "dist/assets/config.json", JSON.stringify({
        token: "abcdefgh12345678"
      }));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner([
          ...cleanPackFiles(),
          "dist/assets/config.json"
        ]),
        ...releaseIdentity,
        now
      });
      const sensitiveCheck = result.checks.find((check) => check.name === "sensitive_artifact_scan");
      const packCheck = result.checks.find((check) => check.name === "npm_pack_manifest");

      expect(result.status).toBe("blocked");
      expect(sensitiveCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              path: "dist/assets/config.json",
              pattern: "token field"
            })
          ])
        })
      });
      expect(packCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          sensitiveFindings: expect.arrayContaining([
            expect.objectContaining({
              path: "dist/assets/config.json",
              pattern: "token field"
            })
          ])
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when package bin.siteflow does not point at the compiled CLI entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-bin-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "package.json", JSON.stringify({
        name: "siteflow-console",
        private: true,
        engines: {
          node: ">=20.0.0"
        },
        bin: {
          siteflow: "./dist-cli/cli/siteflowCli.js"
        }
      }, null, 2));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.checks.find((check) => check.name === "package_bin_siteflow")).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks test outputs and stale root-level CLI artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-topology-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "dist-server/src/domain/status.test.js", "export const staleTest = true;");
      await writeText(root, "dist-cli/index.js", "console.log('stale root cli output');");

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const topologyCheck = result.checks.find((check) => check.name === "artifact_topology");

      expect(result.status).toBe("blocked");
      expect(topologyCheck).toMatchObject({
        status: "fail",
        message: expect.stringContaining("topology issue")
      });
      expect(JSON.stringify(topologyCheck?.details)).toContain("dist-server/src/domain/status.test.js");
      expect(JSON.stringify(topologyCheck?.details)).toContain("dist-cli/index.js");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks source maps that embed sourcesContent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-sourcemap-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "dist/assets/index.js.map", JSON.stringify({
        version: 3,
        file: "index.js",
        sources: ["../../src/main.ts"],
        sourcesContent: ["const token = 'not-for-release';"],
        mappings: ""
      }));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner([
          ...cleanPackFiles(),
          "dist/assets/index.js.map"
        ]),
        ...releaseIdentity,
        now
      });
      const topologyCheck = result.checks.find((check) => check.name === "artifact_topology");

      expect(result.status).toBe("blocked");
      expect(topologyCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              path: "dist/assets/index.js.map",
              reason: expect.stringContaining("sourcesContent")
            })
          ])
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks symlinked artifact entries instead of silently skipping them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-symlink-"));

    try {
      await writeCleanArtifacts(root);

      try {
        await symlink("index.js", path.join(root, "dist", "assets", "linked.js"), "file");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const topologyCheck = result.checks.find((check) => check.name === "artifact_topology");

      expect(result.status).toBe("blocked");
      expect(topologyCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              path: "dist/assets/linked.js",
              reason: expect.stringContaining("symlink")
            })
          ])
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks artifact directories that escape the repository root without scanning outside files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-dir-escape-"));
    const repoRoot = path.join(root, "repo");
    const outsideRoot = path.join(root, "outside-dist");

    try {
      await writeCleanArtifacts(repoRoot);
      await writeText(outsideRoot, "index.html", "Outside Secret Authorization: Bearer outside-secret-token");

      const result = await runReleaseArtifactCheck({
        rootDir: repoRoot,
        artifactDirs: ["../outside-dist"],
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const topologyCheck = result.checks.find((check) => check.name === "artifact_topology");
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(topologyCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              path: "../outside-dist",
              reason: expect.stringContaining("repository root")
            })
          ])
        })
      });
      expect(serialized).not.toContain("outside-secret-token");
      expect(serialized).not.toContain("Outside Secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks scanning the repository root as a release artifact directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-root-dir-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        artifactDirs: ["."],
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.checks.find((check) => check.name === "artifact_topology")).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({
              path: ".",
              reason: expect.stringContaining("named release artifact subdirectory")
            })
          ])
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects release artifact manifest paths outside the repository root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-manifest-escape-"));

    try {
      await writeCleanArtifacts(root);

      await expect(runReleaseArtifactCheck({
        rootDir: root,
        manifestPath: "../release-artifact-manifest.json",
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      })).rejects.toThrow("Release artifact manifest path must stay within the repository root.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks npm package manifests that include source, workflow, CI, or env files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-pack-pollution-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, ".workflow/session.json", "{}");
      await writeText(root, ".github/workflows/ci.yml", "name: ci");
      await writeText(root, "src/main.ts", "export const source = true;");
      await writeText(root, ".env.example", "SITEFLOW_APP_SECRET=<secret>");

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner([
          ...cleanPackFiles(),
          ".workflow/session.json",
          ".github/workflows/ci.yml",
          "src/main.ts",
          ".env.example"
        ]),
        ...releaseIdentity,
        now
      });
      const packCheck = result.checks.find((check) => check.name === "npm_pack_manifest");

      expect(result.status).toBe("blocked");
      expect(packCheck).toMatchObject({
        status: "fail",
        message: expect.stringContaining("npm pack dry-run")
      });
      expect(JSON.stringify(packCheck?.details)).toContain(".workflow/session.json");
      expect(JSON.stringify(packCheck?.details)).toContain(".github/workflows/ci.yml");
      expect(JSON.stringify(packCheck?.details)).toContain("src/main.ts");
      expect(JSON.stringify(packCheck?.details)).toContain(".env.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes npm pack backslash paths and blocks entries that escape the package root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-pack-paths-"));

    try {
      await writeCleanArtifacts(root);
      const deploymentArtifactManifestPath = await writeDeploymentArtifactManifest(root);

      const normalizedResult = await runReleaseArtifactCheck({
        rootDir: root,
        deploymentArtifactManifestPath,
        runAudit: false,
        commandRunner: passingCommandRunner(cleanPackFiles().map((file) =>
          file === "dist/assets/index.js" ? "dist\\assets\\index.js" : file
        )),
        ...releaseIdentity,
        now
      });

      expect(normalizedResult.status).toBe("passed");

      const blockedResult = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner([
          ...cleanPackFiles(),
          "package/../../.env",
          "/tmp/secret.txt",
          "C:\\secret\\outside.txt"
        ]),
        ...releaseIdentity,
        now
      });
      const packCheck = blockedResult.checks.find((check) => check.name === "npm_pack_manifest");

      expect(blockedResult.status).toBe("blocked");
      expect(packCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          pathFindings: expect.arrayContaining([
            expect.objectContaining({
              path: "../../.env",
              reason: expect.stringContaining("escape")
            }),
            expect.objectContaining({
              path: "/tmp/secret.txt",
              reason: expect.stringContaining("escape")
            }),
            expect.objectContaining({
              path: "C:/secret/outside.txt",
              reason: expect.stringContaining("escape")
            })
          ])
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks package manifests without a files allowlist or with pack lifecycle scripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-pack-policy-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "package.json", JSON.stringify({
        name: "siteflow-console",
        private: true,
        engines: {
          node: ">=20.0.0"
        },
        bin: {
          siteflow: "./dist-cli/cli/index.js"
        },
        scripts: {
          prepare: "node scripts/build.js"
        }
      }, null, 2));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const packCheck = result.checks.find((check) => check.name === "npm_pack_manifest");

      expect(result.status).toBe("blocked");
      expect(packCheck).toMatchObject({
        status: "fail"
      });
      expect(JSON.stringify(packCheck?.details)).toContain("files allowlist");
      expect(JSON.stringify(packCheck?.details)).toContain("prepare");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks package metadata that drops private artifact policy or Node 20 engines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-metadata-policy-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, "package.json", JSON.stringify({
        name: "siteflow-console",
        private: false,
        engines: {
          node: ">=18"
        },
        bin: {
          siteflow: "./dist-cli/cli/index.js"
        },
        files: [
          "dist/",
          "dist-cli/",
          "dist-server/",
          "dist-worker/"
        ]
      }, null, 2));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const metadataCheck = result.checks.find((check) => check.name === "package_metadata_policy");

      expect(result.status).toBe("blocked");
      expect(metadataCheck).toMatchObject({
        status: "fail"
      });
      expect(JSON.stringify(metadataCheck?.details)).toContain("private");
      expect(JSON.stringify(metadataCheck?.details)).toContain("engines.node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when the container image publish pipeline is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-image-pipeline-"));

    try {
      await writeCleanArtifacts(root);
      await rm(path.join(root, ".github"), { recursive: true, force: true });

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const imagePipelineCheck = result.checks.find((check) => check.name === "container_image_pipeline");

      expect(result.status).toBe("blocked");
      expect(imagePipelineCheck).toMatchObject({
        status: "fail"
      });
      expect(JSON.stringify(imagePipelineCheck?.details)).toContain("release-image.yml");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when the container image workflow omits digest evidence upload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-image-evidence-"));

    try {
      await writeCleanArtifacts(root);
      await writeText(root, ".github/workflows/release-image.yml", [
        "name: Release Image",
        "jobs:",
        "  publish:",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        id: build",
        "        with:",
        "          push: true",
        "          provenance: true",
        "          sbom: true",
        "          tags: ghcr.io/siteflow/siteflow:0.1.0"
      ].join("\n"));

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        ...releaseIdentity,
        now
      });
      const imagePipelineCheck = result.checks.find((check) => check.name === "container_image_pipeline");

      expect(result.status).toBe("blocked");
      expect(imagePipelineCheck).toMatchObject({
        status: "fail"
      });
      expect(JSON.stringify(imagePipelineCheck?.details)).toContain("digest evidence");
      expect(JSON.stringify(imagePipelineCheck?.details)).toContain("workflow artifact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when dependency policy fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-dependency-policy-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        commandRunner: async (command) => {
          if (command.args.includes("pack")) {
            return {
              exitCode: 0,
              stdout: packOutput(),
              stderr: ""
            };
          }

          if (command.args.some((arg) => arg.endsWith("releaseDependencyPolicyCheck.mjs"))) {
            return {
              exitCode: 1,
              stdout: dependencyPolicyOutput("blocked"),
              stderr: ""
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ vulnerabilities: {} }),
            stderr: ""
          };
        },
        ...releaseIdentity,
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.dependencyPolicyStatus).toBe("blocked");
      expect(result.checks.find((check) => check.name === "dependency_policy")).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          status: "blocked",
          failedChecks: [
            {
              name: "dependency_manifest_lock_sync",
              message: "blocked"
            }
          ]
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts sensitive command output previews when dependency policy fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-policy-secret-output-"));
    const secretOutput = "postgres://siteflow:secret-password@db.internal/siteflow";

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        commandRunner: async (command) => {
          if (command.args.includes("pack")) {
            return {
              exitCode: 0,
              stdout: packOutput(),
              stderr: ""
            };
          }

          if (command.args.some((arg) => arg.endsWith("releaseDependencyPolicyCheck.mjs"))) {
            return {
              exitCode: 1,
              stdout: dependencyPolicyOutput("blocked"),
              stderr: secretOutput
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ vulnerabilities: {} }),
            stderr: ""
          };
        },
        ...releaseIdentity,
        now
      });
      const dependencyCheck = result.checks.find((check) => check.name === "dependency_policy");
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(dependencyCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          outputSensitive: true,
          stderrPreview: "[redacted: sensitive command output omitted]",
          stderrSensitiveReasons: expect.arrayContaining(["Postgres URL password"])
        })
      });
      expect(serialized).not.toContain("secret-password");
      expect(serialized).not.toContain(secretOutput);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts sensitive npm pack output previews when dry-run fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-pack-secret-output-"));
    const secretOutput = "Authorization: Bearer abcdefghijklmnop";

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: async (command) => {
          if (command.args.includes("pack")) {
            return {
              exitCode: 1,
              stdout: secretOutput,
              stderr: ""
            };
          }

          if (command.args.some((arg) => arg.endsWith("releaseDependencyPolicyCheck.mjs"))) {
            return {
              exitCode: 0,
              stdout: dependencyPolicyOutput(),
              stderr: ""
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ vulnerabilities: {} }),
            stderr: ""
          };
        },
        ...releaseIdentity,
        now
      });
      const packCheck = result.checks.find((check) => check.name === "npm_pack_manifest");
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(packCheck).toMatchObject({
        status: "fail",
        details: expect.objectContaining({
          outputSensitive: true,
          stdoutPreview: "[redacted: sensitive command output omitted]",
          stdoutSensitiveReasons: expect.arrayContaining(["authorization bearer token"])
        })
      });
      expect(serialized).not.toContain("abcdefghijklmnop");
      expect(serialized).not.toContain(secretOutput);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when production dependency audit fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-audit-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        commandRunner: async (command) => {
          if (command.args.includes("pack")) {
            return {
              exitCode: 0,
              stdout: packOutput(),
              stderr: ""
            };
          }

          if (command.args.some((arg) => arg.endsWith("releaseDependencyPolicyCheck.mjs"))) {
            return {
              exitCode: 0,
              stdout: dependencyPolicyOutput(),
              stderr: ""
            };
          }

          return {
            exitCode: 1,
            stdout: JSON.stringify({ vulnerabilities: { pg: { severity: "high" } } }),
            stderr: ""
          };
        },
        ...releaseIdentity,
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.auditExitCode).toBe(1);
      expect(result.checks.find((check) => check.name === "production_dependency_audit")).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when release identity is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifacts-identity-"));

    try {
      await writeCleanArtifacts(root);

      const result = await runReleaseArtifactCheck({
        rootDir: root,
        runAudit: false,
        commandRunner: passingCommandRunner(),
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.checks.find((check) => check.name === "release_identity")).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses repeatable artifact directories and skip-audit", () => {
    expect(parseReleaseArtifactCheckArgs([
      "--root",
      "repo",
      "--dir",
      "dist",
      "--dir",
      "dist-cli",
      "--manifest",
      "manifest.json",
      "--deployment-artifact-manifest",
      "deployment-artifact-manifest.json",
      "--write-deployment-artifact-manifest",
      "evidence/deployment-artifact-manifest.json",
      "--commit-ref",
      "abc123",
      "--repo",
      "acme/siteflow",
      "--branch",
      "main",
      "--target-environment",
      "production",
      "--skip-audit",
      "--json"
    ])).toEqual({
      rootDir: "repo",
      artifactDirs: ["dist", "dist-cli"],
      manifestPath: "manifest.json",
      deploymentArtifactManifestPath: "deployment-artifact-manifest.json",
      writeDeploymentArtifactManifestPath: "evidence/deployment-artifact-manifest.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      runAudit: false,
      json: true,
      help: false
    });
  });
});
