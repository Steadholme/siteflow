import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts", "releaseDependencyPolicyCheck.mjs");

async function writeJson(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runPolicy(root: string) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, "--root", root, "--json"], {
      encoding: "utf8"
    });

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: JSON.parse(result.stdout)
    };
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string; code?: number };
    const stdout = execError.stdout ?? "";

    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout,
      stderr: execError.stderr ?? "",
      json: JSON.parse(stdout)
    };
  }
}

async function writePolicyFixture(root: string, overrides: {
  packageJson?: Record<string, unknown>;
  packageLock?: Record<string, unknown>;
} = {}) {
  const packageJson = {
    name: "siteflow-console",
    version: "0.1.0",
    private: true,
    dependencies: {
      react: "^18.3.1"
    },
    devDependencies: {
      esbuild: "^0.21.5",
      fsevents: "^2.3.3"
    },
    ...overrides.packageJson
  };
  const packageLock = {
    name: "siteflow-console",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          react: "^18.3.1"
        },
        devDependencies: {
          esbuild: "^0.21.5",
          fsevents: "^2.3.3"
        }
      },
      "node_modules/react": {
        version: "18.3.1",
        resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
        integrity: "sha512-react"
      },
      "node_modules/esbuild": {
        version: "0.21.5",
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz",
        integrity: "sha512-esbuild",
        dev: true,
        hasInstallScript: true
      },
      "node_modules/fsevents": {
        version: "2.3.3",
        resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
        integrity: "sha512-fsevents",
        dev: true,
        optional: true,
        hasInstallScript: true
      }
    },
    ...overrides.packageLock
  };

  await writeJson(root, "package.json", packageJson);
  await writeJson(root, "package-lock.json", packageLock);
}

describe("releaseDependencyPolicyCheck", () => {
  it("passes registry dependencies with integrity and reviewed dev install scripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-deps-policy-pass-"));

    try {
      await writePolicyFixture(root);

      const result = await runPolicy(root);

      expect(result.exitCode).toBe(0);
      expect(result.json.status).toBe("passed");
      expect(result.json.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "dependency_manifest_protocols", status: "pass" }),
          expect.objectContaining({
            name: "dependency_install_scripts",
            status: "pass",
            details: expect.objectContaining({
              allowedDevInstallScripts: expect.arrayContaining([
                expect.objectContaining({ package: "esbuild@0.21.5" }),
                expect.objectContaining({ package: "fsevents@2.3.3" })
              ])
            })
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks forbidden dependency protocols and package manifest lock drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-deps-policy-drift-"));

    try {
      await writePolicyFixture(root, {
        packageJson: {
          dependencies: {
            react: "^18.3.1",
            unsafe: "git+ssh://github.com/acme/unsafe.git"
          }
        },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                react: "^17.0.0"
              },
              devDependencies: {
                esbuild: "^0.21.5",
                fsevents: "^2.3.3"
              }
            },
            "node_modules/react": {
              version: "18.3.1",
              resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
              integrity: "sha512-react"
            },
            "node_modules/esbuild": {
              version: "0.21.5",
              resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz",
              integrity: "sha512-esbuild",
              dev: true,
              hasInstallScript: true
            },
            "node_modules/fsevents": {
              version: "2.3.3",
              resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
              integrity: "sha512-fsevents",
              dev: true,
              optional: true,
              hasInstallScript: true
            }
          }
        }
      });

      const result = await runPolicy(root);

      expect(result.exitCode).toBe(1);
      expect(result.json.status).toBe("blocked");
      expect(result.json.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "dependency_manifest_protocols", status: "fail" }),
          expect.objectContaining({ name: "dependency_manifest_lock_sync", status: "fail" }),
          expect.objectContaining({ name: "production_dependency_lock_entries", status: "fail" })
        ])
      );
      expect(JSON.stringify(result.json)).toContain("git+ssh://github.com/acme/unsafe.git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks non-registry resolved packages, missing integrity, and production install scripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-deps-policy-lock-"));

    try {
      await writePolicyFixture(root, {
        packageJson: {
          dependencies: {
            react: "^18.3.1",
            "native-prod": "^1.0.0",
            "missing-integrity": "^1.0.0",
            external: "^1.0.0"
          }
        },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                react: "^18.3.1",
                "native-prod": "^1.0.0",
                "missing-integrity": "^1.0.0",
                external: "^1.0.0"
              },
              devDependencies: {
                esbuild: "^0.21.5"
              }
            },
            "node_modules/react": {
              version: "18.3.1",
              resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
              integrity: "sha512-react"
            },
            "node_modules/native-prod": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/native-prod/-/native-prod-1.0.0.tgz",
              integrity: "sha512-native-prod",
              hasInstallScript: true
            },
            "node_modules/missing-integrity": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/missing-integrity/-/missing-integrity-1.0.0.tgz"
            },
            "node_modules/external": {
              version: "1.0.0",
              resolved: "https://example.com/external-1.0.0.tgz",
              integrity: "sha512-external"
            },
            "node_modules/esbuild": {
              version: "0.21.5",
              resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz",
              integrity: "sha512-esbuild",
              dev: true,
              hasInstallScript: true
            }
          }
        }
      });

      const result = await runPolicy(root);

      expect(result.exitCode).toBe(1);
      expect(result.json.status).toBe("blocked");
      expect(result.json.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "dependency_lock_sources", status: "fail" }),
          expect.objectContaining({ name: "dependency_install_scripts", status: "fail" })
        ])
      );
      expect(JSON.stringify(result.json)).toContain("https://example.com/external-1.0.0.tgz");
      expect(JSON.stringify(result.json)).toContain("native-prod@1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
