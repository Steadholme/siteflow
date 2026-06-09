import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findForbiddenTrackedReleasePaths,
  forbiddenTrackedReleasePathFiles,
  forbiddenTrackedReleasePathPatterns,
  forbiddenTrackedReleasePathPrefixes,
  normalizeTrackedReleasePath,
  releaseSourceTreeForbiddenPathspecs,
  releaseSourceTreePolicyDetails,
  type ForbiddenTrackedReleasePathFinding
} from "../cli/releaseSourceTreePolicy.js";

type CommitPlanStatus = "blocked" | "pass";

export interface ReleaseCommitReadinessCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseCommitReadinessCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<ReleaseCommitReadinessCommandResult>;

export interface ReleaseCommitReadinessPlanOptions {
  rootDir?: string;
  outputPath?: string;
  maxFindings?: number;
  commandRunner?: ReleaseCommitReadinessCommandRunner;
  now?: () => Date;
}

export interface ReleaseCommitReadinessRootSummary {
  root: string;
  reason: string;
  count: number;
  samplePaths: string[];
}

export interface ReleaseCommitReadinessPathSummary<T> {
  total: number;
  returned: number;
  truncated: boolean;
  paths: T[];
}

export interface ReleaseCommitCriticalUntrackedFinding {
  path: string;
  category: string;
  reason: string;
}

export interface ReleaseCommitTrackedDirtySourceFinding {
  path: string;
  status: string;
  category: string;
  reason: string;
}

export interface ReleaseCommitUntrackedSourceFinding {
  path: string;
  category: string;
  reason: string;
  blockingReleaseCommit: true;
}

interface ReleaseCommitStagingFinding {
  path: string;
  category: string;
  reason: string;
}

export interface ReleaseCommitSuggestedStagingGroup {
  id: string;
  description: string;
  pathspecs: string[];
  command: {
    command: "git";
    args: string[];
    display: string;
    modifiesGitIndex: true;
    removesWorkingTreeFiles: false;
    requiresReview: true;
  };
}

export interface ReleaseCommitRecommendedCommand {
  id: string;
  description: string;
  command: string;
  args: string[];
  display: string;
  modifiesGitIndex: boolean;
  removesWorkingTreeFiles: false;
  requiresReview: true;
  notes: string[];
}

export interface ReleaseCommitStagingCoverage {
  covered: boolean;
  requiredPathCount: number;
  coveredRequiredPathCount: number;
  suggestedPathspecCount: number;
  missingRequiredPaths: string[];
  excludedSuggestedPathspecs: string[];
}

export interface ReleaseCommitReadinessPlanResult {
  name: "siteflow-release-commit-readiness-plan";
  status: CommitPlanStatus;
  checkedAt: string;
  rootDir: string;
  outputPath?: string;
  trackedPathCount: number | null;
  forbiddenPathCount: number | null;
  forbiddenRoots: ReleaseCommitReadinessRootSummary[];
  forbiddenPaths: ReleaseCommitReadinessPathSummary<ForbiddenTrackedReleasePathFinding>;
  criticalUntracked: ReleaseCommitReadinessPathSummary<ReleaseCommitCriticalUntrackedFinding>;
  untrackedSource: ReleaseCommitReadinessPathSummary<ReleaseCommitUntrackedSourceFinding>;
  trackedDirtySource: ReleaseCommitReadinessPathSummary<ReleaseCommitTrackedDirtySourceFinding>;
  suggestedStagingGroups: ReleaseCommitSuggestedStagingGroup[];
  stagingCoverage: ReleaseCommitStagingCoverage;
  excludedFromStaging: string[];
  recommendedCommands: ReleaseCommitRecommendedCommand[];
  warnings: string[];
  policy: ReturnType<typeof releaseSourceTreePolicyDetails>;
  errors: string[];
  exitCode: number;
}

interface ParsedArgs {
  rootDir?: string;
  outputPath?: string;
  reviewChecklist: boolean;
  reviewChecklistOutputPath?: string;
  maxFindings?: number;
  json: boolean;
  failOnBlocked: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface CriticalPathRule {
  category: string;
  reason: string;
  matches: (filePath: string) => boolean;
}

interface SourcePathClassification {
  category: string;
  reason: string;
}

interface ReleaseScriptCategoryRule {
  category: string;
  reason: string;
  matches: (filePath: string) => boolean;
}

const defaultMaxFindings = 50;
const criticalExactPaths = new Map<string, { category: string; reason: string }>([
  [".github/workflows/ci.yml", { category: "workflow", reason: "CI workflow must be part of the release commit." }],
  [".github/workflows/release-preflight.yml", { category: "workflow", reason: "Release preflight workflow must be part of the release commit." }],
  [".github/workflows/release-image.yml", { category: "workflow", reason: "Release image workflow must be part of the release commit." }],
  [".gitignore", { category: "source_policy", reason: "Release source ignore policy must be committed." }],
  [".dockerignore", { category: "source_policy", reason: "Docker build context policy must be committed." }],
  ["Dockerfile", { category: "container", reason: "Production container build file must be committed." }],
  ["docker-compose.production.yml", { category: "container", reason: "Auditable production Compose profile must be committed." }],
  ["PRODUCTION.md", { category: "production_docs", reason: "Top-level production launch and go/no-go entrypoint must be committed." }],
  [".env.example", { category: "operations", reason: "Documented environment template must be committed." }],
  ["tsconfig.scripts.json", { category: "release_tooling", reason: "Release evidence scripts typecheck project must be committed." }],
  ["cli/releaseGate.ts", { category: "release_tooling", reason: "Release gate implementation must be committed." }],
  ["cli/releaseGate.test.ts", { category: "release_tooling", reason: "Release gate tests must be committed with the gate." }],
  ["cli/releaseSourceTreePolicy.ts", { category: "release_tooling", reason: "Release source policy must be committed." }]
]);
const criticalRules: CriticalPathRule[] = [
  {
    category: "release_scripts",
    reason: "Release, backup, observability, source, ingress, operator, credential, artifact retention, install profile, and rollback evidence scripts must be committed.",
    matches: (filePath) => /^scripts\/(release|backup|observability|operator|ingress|source|upgrade|nonSession|postgres|dockerBuild|artifactRetention|installProfileCheck|productionRuntimeProfileContract|evidenceSecretScan|runCompiledScript|cleanBuildArtifacts|assertBrowserBuildEnv|browserProductionBoundary)/.test(filePath)
  },
  {
    category: "production_docs",
    reason: "Production readiness, operations, private repository, and distance documentation must be committed.",
    matches: (filePath) =>
      /^docs\/(production-readiness|operations-runbook|production-distance-matrix|private-repo-credentials).*\.md$/.test(filePath) ||
      filePath === "docs/deployment/production-single-host.md"
  }
];
const releaseScriptCategoryRules: ReleaseScriptCategoryRule[] = [
  {
    category: "release_evidence_pack_scripts",
    reason: "Release evidence pack, gap, target-run, bundle, and contract scripts must be reviewed and staged together by evidence-pack domain.",
    matches: (filePath) => /^scripts\/releaseEvidence/.test(filePath)
  },
  {
    category: "release_artifact_runtime_scripts",
    reason: "Release artifact, target runtime, artifact retention, and install-profile scripts must be reviewed and staged together by runtime/artifact domain.",
    matches: (filePath) => /^scripts\/(?:releaseArtifact|releaseTargetRuntime|artifactRetention|installProfileCheck|productionRuntimeProfileContract)/.test(filePath)
  },
  {
    category: "release_gate_source_scripts",
    reason: "Release commit, source-tree, dependency, and post-promotion scripts must be reviewed and staged together by release-gate domain.",
    matches: (filePath) => /^scripts\/(?:releaseCommit|releaseSource|releaseDependency|releasePostPromotion)/.test(filePath)
  },
  {
    category: "backup_evidence_scripts",
    reason: "Backup automation and backup evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/backup/.test(filePath)
  },
  {
    category: "observability_evidence_scripts",
    reason: "Observability provisioning, collection, checker, and operator-template scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/observability/.test(filePath)
  },
  {
    category: "operator_access_evidence_scripts",
    reason: "Operator access evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/operator/.test(filePath)
  },
  {
    category: "credential_evidence_scripts",
    reason: "Non-session credential evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/nonSession/.test(filePath)
  },
  {
    category: "source_provider_evidence_scripts",
    reason: "Source provider evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/source/.test(filePath)
  },
  {
    category: "ingress_evidence_scripts",
    reason: "Ingress evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/ingress/.test(filePath)
  },
  {
    category: "upgrade_rollback_evidence_scripts",
    reason: "Upgrade and rollback drill evidence scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/upgrade/.test(filePath)
  },
  {
    category: "rehearsal_runner_scripts",
    reason: "Docker and Postgres rehearsal runner scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/(?:postgres|dockerBuild)/.test(filePath)
  },
  {
    category: "release_support_scripts",
    reason: "Shared release support scripts must be reviewed and staged together.",
    matches: (filePath) => /^scripts\/(?:evidenceSecretScan|runCompiledScript|cleanBuildArtifacts|assertBrowserBuildEnv|browserProductionBoundary|isoTimestamp)/.test(filePath)
  }
];
const excludedFromStaging = releaseSourceTreeForbiddenPathspecs();
const untrackedSourceRules: Array<{ category: string; reason: string; matches: (filePath: string) => boolean }> = [
  {
    category: "cli",
    reason: "Untracked CLI source must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^cli\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "server",
    reason: "Untracked server source must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^server\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "worker",
    reason: "Untracked worker source must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^worker\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "frontend",
    reason: "Untracked frontend source must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^src\/.*\.(?:ts|tsx|js|jsx|css)$/.test(filePath)
  },
  {
    category: "tests",
    reason: "Untracked test source must be reviewed and staged explicitly with the release change.",
    matches: (filePath) => /(?:^|\/)(?:tests?\/.*|[^/]+\.test)\.(?:ts|tsx|js|jsx)$/.test(filePath)
  },
  {
    category: "release_scripts",
    reason: "Untracked release script source must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^scripts\/.*\.(?:ts|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "config",
    reason: "Untracked build or test configuration must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^(?:vite\.config\.ts|tsconfig[^/]*\.json|.*\.config\.(?:ts|js|mjs|cjs))$/.test(filePath)
  }
];
const trackedSourceRules: Array<{ category: string; reason: string; matches: (filePath: string) => boolean }> = [
  {
    category: "package_manifest",
    reason: "Tracked package manifest or lockfile change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^(?:package\.json|package-lock\.json)$/.test(filePath)
  },
  {
    category: "config",
    reason: "Tracked build or test configuration change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^(?:vite\.config\.ts|tsconfig[^/]*\.json|.*\.config\.(?:ts|js|mjs|cjs))$/.test(filePath)
  },
  {
    category: "cli",
    reason: "Tracked CLI source change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^cli\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "server",
    reason: "Tracked server source change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^server\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "worker",
    reason: "Tracked worker source change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^worker\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(filePath)
  },
  {
    category: "frontend",
    reason: "Tracked frontend source change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /^src\/.*\.(?:ts|tsx|js|jsx|css)$/.test(filePath)
  },
  {
    category: "tests",
    reason: "Tracked test source change must be reviewed and staged explicitly before the release commit.",
    matches: (filePath) => /(?:^|\/)(?:tests?\/.*|[^/]+\.test)\.(?:ts|tsx|js|jsx)$/.test(filePath)
  }
];

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

export const defaultReleaseCommitReadinessCommandRunner: ReleaseCommitReadinessCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      const commandError = error as NodeJS.ErrnoException | null;
      const exitCode = typeof commandError?.code === "number" ? Number(commandError.code) : commandError ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });

function splitTrackedPaths(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeTrackedReleasePath(line))
    .filter(Boolean);
}

function statusEntries(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      let filePath = line.slice(3);

      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").at(-1) ?? filePath;
      }

      if (filePath.startsWith("\"") && filePath.endsWith("\"")) {
        filePath = filePath.slice(1, -1);
      }

      return {
        status,
        path: normalizeTrackedReleasePath(filePath)
      };
    })
    .filter((entry) => entry.path);
}

function shellQuotePathspec(pathspec: string) {
  if (/^[A-Za-z0-9._/@:-]+$/.test(pathspec)) {
    return pathspec;
  }

  return `"${pathspec.replace(/(["`$\\])/g, "\\$1")}"`;
}

function formatGitPathspecCommand(argsBeforePathspecs: string[], pathspecs: string[]) {
  return ["git", ...argsBeforePathspecs, "--", ...pathspecs.map(shellQuotePathspec)].join(" ");
}

function pushChecklistCommand(lines: string[], label: string, command: string) {
  lines.push(`- [ ] ${label}:`);
  lines.push("```sh");
  lines.push(command);
  lines.push("```");
}

function classifyForbiddenPath(filePath: string) {
  const normalized = normalizeTrackedReleasePath(filePath);
  const prefix = forbiddenTrackedReleasePathPrefixes.find((entry) => normalized.startsWith(entry.prefix));

  if (prefix) {
    return {
      label: prefix.prefix.replace(/\/$/, ""),
      reason: prefix.reason
    };
  }

  const exact = forbiddenTrackedReleasePathFiles.find((entry) => normalized === entry.path);

  if (exact) {
    return {
      label: exact.path,
      reason: exact.reason
    };
  }

  const pattern = forbiddenTrackedReleasePathPatterns.find((entry) => entry.pattern.test(normalized));

  if (pattern) {
    return {
      label: pattern.label,
      reason: pattern.reason
    };
  }

  return {
    label: "unclassified",
    reason: "Release source policy found this path, but no cleanup group matched."
  };
}

function summarizeForbiddenRoots(findings: ForbiddenTrackedReleasePathFinding[], maxFindings: number) {
  const roots = new Map<string, ReleaseCommitReadinessRootSummary>();

  for (const finding of findings) {
    const classification = classifyForbiddenPath(finding.path);
    const root = roots.get(classification.label) ?? {
      root: classification.label,
      reason: classification.reason,
      count: 0,
      samplePaths: []
    };

    root.count += 1;

    if (root.samplePaths.length < maxFindings) {
      root.samplePaths.push(finding.path);
    }

    roots.set(classification.label, root);
  }

  return [...roots.values()].sort((left, right) => right.count - left.count || left.root.localeCompare(right.root));
}

function summarizePaths<T>(paths: T[], maxFindings: number): ReleaseCommitReadinessPathSummary<T> {
  const returned = paths.slice(0, maxFindings);

  return {
    total: paths.length,
    returned: returned.length,
    truncated: paths.length > maxFindings,
    paths: returned
  };
}

function criticalUntrackedFinding(filePath: string): ReleaseCommitCriticalUntrackedFinding | undefined {
  const exact = criticalExactPaths.get(filePath);

  if (exact) {
    return {
      path: filePath,
      category: exact.category,
      reason: exact.reason
    };
  }

  const releaseScript = releaseScriptClassification(filePath);

  if (releaseScript) {
    return {
      path: filePath,
      category: releaseScript.category,
      reason: releaseScript.reason
    };
  }

  for (const rule of criticalRules) {
    if (rule.matches(filePath)) {
      return {
        path: filePath,
        category: rule.category,
        reason: rule.reason
      };
    }
  }

  return undefined;
}

function releaseScriptClassification(filePath: string): SourcePathClassification | undefined {
  return releaseScriptCategoryRules.find((rule) => rule.matches(filePath));
}

function untrackedSourceClassification(filePath: string): SourcePathClassification | undefined {
  if (findForbiddenTrackedReleasePaths([filePath]).length > 0 || criticalUntrackedFinding(filePath)) {
    return undefined;
  }

  return untrackedSourceRules.find((rule) => rule.matches(filePath));
}

function untrackedSourceFinding(filePath: string): ReleaseCommitUntrackedSourceFinding | undefined {
  const classification = untrackedSourceClassification(filePath);

  if (!classification) {
    return undefined;
  }

  return {
    path: filePath,
    category: classification.category,
    reason: classification.reason,
    blockingReleaseCommit: true
  };
}

function stagingClassification(filePath: string) {
  const exact = criticalExactPaths.get(filePath);

  if (exact) {
    return exact;
  }

  const releaseScript = releaseScriptClassification(filePath);

  if (releaseScript) {
    return releaseScript;
  }

  for (const rule of criticalRules) {
    if (rule.matches(filePath)) {
      return {
        category: rule.category,
        reason: rule.reason
      };
    }
  }

  for (const rule of trackedSourceRules) {
    if (rule.matches(filePath)) {
      return {
        category: rule.category,
        reason: rule.reason
      };
    }
  }

  return {
    category: "tracked_source",
    reason: "Tracked source change must be reviewed and staged explicitly before the release commit."
  };
}

function trackedDirtySourceFinding(entry: { status: string; path: string }): ReleaseCommitTrackedDirtySourceFinding | undefined {
  if (entry.status === "??" || findForbiddenTrackedReleasePaths([entry.path]).length > 0) {
    return undefined;
  }

  const classification = stagingClassification(entry.path);

  return {
    path: entry.path,
    status: entry.status,
    category: classification.category,
    reason: classification.reason
  };
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stagingPathspecsByGroup(findings: ReleaseCommitStagingFinding[]) {
  const byCategory = new Map<string, ReleaseCommitStagingFinding[]>();

  for (const finding of findings) {
    byCategory.set(finding.category, [...(byCategory.get(finding.category) ?? []), finding]);
  }

  return [...byCategory.entries()].map(([category, findings]) => {
    const pathspecs = uniqueSorted(findings.map((finding) => finding.path));
    const args = ["add", "--", ...pathspecs];

    return {
      id: category,
      description: `Review and stage ${category.replace(/_/g, " ")} release files explicitly.`,
      pathspecs,
      command: {
        command: "git" as const,
        args,
        display: ["git", ...args.map(shellQuotePathspec)].join(" "),
        modifiesGitIndex: true as const,
        removesWorkingTreeFiles: false as const,
        requiresReview: true as const
      }
    };
  });
}

function stagingCoverage(
  findings: ReleaseCommitStagingFinding[],
  suggestedStagingGroups: ReleaseCommitSuggestedStagingGroup[]
): ReleaseCommitStagingCoverage {
  const requiredPaths = uniqueSorted(findings.map((finding) => finding.path));
  const suggestedPathspecs = uniqueSorted(suggestedStagingGroups.flatMap((group) => group.pathspecs));
  const suggestedPathspecSet = new Set(suggestedPathspecs);
  const missingRequiredPaths = requiredPaths.filter((filePath) => !suggestedPathspecSet.has(filePath));
  const excludedSuggestedPathspecs = suggestedPathspecs.filter((pathspec) => findForbiddenTrackedReleasePaths([pathspec]).length > 0);

  return {
    covered: missingRequiredPaths.length === 0 && excludedSuggestedPathspecs.length === 0,
    requiredPathCount: requiredPaths.length,
    coveredRequiredPathCount: requiredPaths.length - missingRequiredPaths.length,
    suggestedPathspecCount: suggestedPathspecs.length,
    missingRequiredPaths,
    excludedSuggestedPathspecs
  };
}

function recommendedCommands(suggestedStagingGroups: ReleaseCommitSuggestedStagingGroup[], hasForbiddenTrackedPaths: boolean) {
  const commands: ReleaseCommitRecommendedCommand[] = [];

  if (hasForbiddenTrackedPaths) {
    commands.push({
      id: "review-release-source-cleanup",
      description: "Generate the index cleanup plan before staging the release commit.",
      command: "npm",
      args: ["run", "--silent", "release:source:cleanup-plan", "--", "--json"],
      display: "npm run --silent release:source:cleanup-plan -- --json",
      modifiesGitIndex: false,
      removesWorkingTreeFiles: false,
      requiresReview: true,
      notes: [
        "Run and review this before applying any index-only cleanup command.",
        "Keep the cleanup commit separate from the release-readiness commit."
      ]
    });
  }

  for (const group of suggestedStagingGroups) {
    commands.push({
      id: `stage-${group.id}`,
      description: group.description,
      command: group.command.command,
      args: group.command.args,
      display: group.command.display,
      modifiesGitIndex: true,
      removesWorkingTreeFiles: false,
      requiresReview: true,
      notes: [
        "Review the listed pathspecs before staging.",
        "Use explicit pathspecs; avoid broad dot staging."
      ]
    });
  }

  return commands;
}

function warnings(hasFindings: boolean) {
  const result = [
    "This tool is read-only for Git: it only inspects git ls-files and git status.",
    "Review all recommended pathspecs before staging or removing anything from the index.",
    "Do not use git add . for release-readiness work.",
    "Do not run git reset, git checkout, git clean, filesystem delete commands, or broad staging as part of this plan."
  ];

  if (hasFindings) {
    result.push("Keep the index-only source cleanup commit separate from the release-readiness staging commit.");
  }

  return result;
}

export async function runReleaseCommitReadinessPlan(
  options: ReleaseCommitReadinessPlanOptions = {}
): Promise<ReleaseCommitReadinessPlanResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const runner = options.commandRunner ?? defaultReleaseCommitReadinessCommandRunner;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const maxFindings = options.maxFindings ?? defaultMaxFindings;
  const outputPath = options.outputPath ? path.resolve(rootDir, options.outputPath) : undefined;
  const [listed, status] = await Promise.all([
    runner("git", ["ls-files"], { cwd: rootDir }),
    runner("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: rootDir })
  ]);
  const errors = [
    ...(listed.exitCode === 0 ? [] : [`git ls-files failed: ${`${listed.stdout}\n${listed.stderr}`.trim() || listed.exitCode}`]),
    ...(status.exitCode === 0 ? [] : [`git status failed: ${`${status.stdout}\n${status.stderr}`.trim() || status.exitCode}`])
  ];
  const policy = releaseSourceTreePolicyDetails();

  if (errors.length > 0) {
    const result: ReleaseCommitReadinessPlanResult = {
      name: "siteflow-release-commit-readiness-plan",
      status: "blocked",
      checkedAt,
      rootDir,
      ...(outputPath ? { outputPath } : {}),
      trackedPathCount: null,
      forbiddenPathCount: null,
      forbiddenRoots: [],
      forbiddenPaths: summarizePaths([], maxFindings),
      criticalUntracked: summarizePaths([], maxFindings),
      untrackedSource: summarizePaths([], maxFindings),
      trackedDirtySource: summarizePaths([], maxFindings),
      suggestedStagingGroups: [],
      stagingCoverage: stagingCoverage([], []),
      excludedFromStaging,
      recommendedCommands: recommendedCommands([], false),
      warnings: warnings(false),
      policy,
      errors,
      exitCode: 1
    };

    if (outputPath) {
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }

    return result;
  }

  const trackedPaths = splitTrackedPaths(listed.stdout);
  const forbiddenFindings = findForbiddenTrackedReleasePaths(trackedPaths);
  const untracked = statusEntries(status.stdout)
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.path);
  const criticalUntracked = untracked
    .map(criticalUntrackedFinding)
    .filter((finding): finding is ReleaseCommitCriticalUntrackedFinding => Boolean(finding))
    .sort((left, right) => left.path.localeCompare(right.path));
  const untrackedSource = untracked
    .map(untrackedSourceFinding)
    .filter((finding): finding is ReleaseCommitUntrackedSourceFinding => Boolean(finding))
    .sort((left, right) => left.path.localeCompare(right.path));
  const dirtyTrackedSource = statusEntries(status.stdout)
    .map(trackedDirtySourceFinding)
    .filter((finding): finding is ReleaseCommitTrackedDirtySourceFinding => Boolean(finding))
    .sort((left, right) => left.path.localeCompare(right.path));
  const requiredStagingFindings = [...criticalUntracked, ...untrackedSource, ...dirtyTrackedSource];
  const suggestedStagingGroups = stagingPathspecsByGroup(requiredStagingFindings);
  const coverage = stagingCoverage(requiredStagingFindings, suggestedStagingGroups);
  const hasFindings = forbiddenFindings.length > 0 || criticalUntracked.length > 0 || untrackedSource.length > 0 || dirtyTrackedSource.length > 0;
  const result: ReleaseCommitReadinessPlanResult = {
    name: "siteflow-release-commit-readiness-plan",
    status: hasFindings || !coverage.covered ? "blocked" : "pass",
    checkedAt,
    rootDir,
    ...(outputPath ? { outputPath } : {}),
    trackedPathCount: trackedPaths.length,
    forbiddenPathCount: forbiddenFindings.length,
    forbiddenRoots: summarizeForbiddenRoots(forbiddenFindings, maxFindings),
    forbiddenPaths: summarizePaths(forbiddenFindings, maxFindings),
    criticalUntracked: summarizePaths(criticalUntracked, maxFindings),
    untrackedSource: summarizePaths(untrackedSource, maxFindings),
    trackedDirtySource: summarizePaths(dirtyTrackedSource, maxFindings),
    suggestedStagingGroups,
    stagingCoverage: coverage,
    excludedFromStaging,
    recommendedCommands: recommendedCommands(suggestedStagingGroups, forbiddenFindings.length > 0),
    warnings: warnings(hasFindings),
    policy,
    errors: [],
    exitCode: 0
  };

  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value: string, flag: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }

  return parsed;
}

export function parseReleaseCommitReadinessPlanArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    reviewChecklist: false,
    json: false,
    failOnBlocked: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      parsed.rootDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--review-checklist") {
      parsed.reviewChecklist = true;
    } else if (arg === "--review-checklist-output") {
      parsed.reviewChecklistOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-findings") {
      parsed.maxFindings = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--fail-on-blocked") {
      parsed.failOnBlocked = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function releaseCommitReadinessPlanUsage() {
  return [
    "Usage: npm run --silent release:commit:plan -- [options]",
    "",
    "Options:",
    "  --root <dir>            Repository root. Default: current working directory.",
    "  --output <file>         Write the commit readiness plan JSON to a file.",
    "  --review-checklist      Emit a Markdown checklist for human pathspec review.",
    "  --review-checklist-output <file>  Write the Markdown review checklist to a file.",
    `  --max-findings <n>      Maximum forbidden and untracked paths to include. Default: ${defaultMaxFindings}.`,
    "  --json                  Emit a single JSON result.",
    "  --fail-on-blocked       Exit 1 when the advisory plan status is blocked.",
    "  --help                  Show this help."
  ].join("\n");
}

export function formatReleaseCommitReviewChecklist(result: ReleaseCommitReadinessPlanResult) {
  const pathDetails = new Map<string, string[]>();
  const recordPathDetail = (filePath: string, detail: string) => {
    pathDetails.set(filePath, [...(pathDetails.get(filePath) ?? []), detail]);
  };

  for (const finding of result.criticalUntracked.paths) {
    recordPathDetail(finding.path, `critical untracked ${finding.category}: ${finding.reason}`);
  }

  for (const finding of result.untrackedSource.paths) {
    recordPathDetail(finding.path, `untracked source ${finding.category}: ${finding.reason}`);
  }

  for (const finding of result.trackedDirtySource.paths) {
    recordPathDetail(finding.path, `tracked dirty ${finding.status.trim() || "changed"} ${finding.category}: ${finding.reason}`);
  }

  const lines: string[] = [
    "# SiteFlow Release Commit Review Checklist",
    "",
    `Status: ${result.status}`,
    `Checked at: ${result.checkedAt}`,
    `Repository root: ${result.rootDir}`,
    `Required paths covered by suggested pathspecs: ${result.stagingCoverage.covered ? "yes" : "no"} (${result.stagingCoverage.coveredRequiredPathCount}/${result.stagingCoverage.requiredPathCount})`,
    "",
    "This checklist is read-only. Review every listed path before running any `git add` command, keep cleanup commits separate from release-readiness commits, and do not use `git add .`.",
    ""
  ];

  if (result.errors.length > 0) {
    lines.push("## Errors", "");
    for (const error of result.errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  if (result.forbiddenRoots.length > 0 || result.forbiddenPaths.total > 0) {
    lines.push("## Source Cleanup Required", "");
    lines.push("- [ ] Run and review `npm run --silent release:source:cleanup-plan -- --json` before staging release files.");
    for (const root of result.forbiddenRoots) {
      lines.push(`- [ ] Resolve forbidden tracked root \`${root.root}\` (${root.count} path(s)): ${root.reason}`);
    }
    for (const finding of result.forbiddenPaths.paths) {
      lines.push(`- [ ] Remove forbidden tracked path from the Git index: \`${finding.path}\``);
    }
    lines.push("");
  }

  if (result.stagingCoverage.missingRequiredPaths.length > 0 || result.stagingCoverage.excludedSuggestedPathspecs.length > 0) {
    lines.push("## Staging Coverage Gaps", "");
    for (const filePath of result.stagingCoverage.missingRequiredPaths) {
      lines.push(`- [ ] Add an explicit reviewed pathspec for \`${filePath}\`.`);
    }
    for (const filePath of result.stagingCoverage.excludedSuggestedPathspecs) {
      lines.push(`- [ ] Remove forbidden/generated pathspec from staging suggestions: \`${filePath}\`.`);
    }
    lines.push("");
  }

  if (result.suggestedStagingGroups.length > 0) {
    lines.push("## Review And Stage Groups", "");
    result.suggestedStagingGroups.forEach((group, groupIndex) => {
      const reviewCommand = formatGitPathspecCommand(["diff", "--stat"], group.pathspecs);
      const fullDiffCommand = formatGitPathspecCommand(["diff"], group.pathspecs);

      lines.push(`### ${groupIndex + 1}. ${group.id}`);
      lines.push("");
      lines.push(group.description);
      lines.push("");
      lines.push(`Path count: ${group.pathspecs.length}`);
      lines.push("");
      lines.push("- [ ] Confirm these paths belong in the same reviewed release-readiness staging group.");
      pushChecklistCommand(lines, "Review diff stats", reviewCommand);
      pushChecklistCommand(lines, "Review full tracked diffs", fullDiffCommand);
      lines.push("- [ ] For untracked paths, open the file contents directly before staging; `git diff` does not show untracked file bodies.");
      pushChecklistCommand(lines, "Stage only after review", group.command.display);
      lines.push("");
      lines.push("Paths:");
      for (const pathspec of group.pathspecs) {
        const details = pathDetails.get(pathspec);
        lines.push(`- \`${pathspec}\`${details ? ` - ${details.join("; ")}` : ""}`);
      }
      lines.push("");
    });
  } else {
    lines.push("## Review And Stage Groups", "", "No release-readiness staging groups are currently suggested.", "");
  }

  if (result.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("## Final Verification", "");
  lines.push("- [ ] Re-run `npm run --silent release:source:check -- --json`.");
  lines.push("- [ ] Inspect the staged release-readiness commit with `git diff --cached --stat` and `git diff --cached`.");
  lines.push("- [ ] After creating the release-readiness commit on a clean checkout, re-run `npm run --silent release:commit:plan -- --fail-on-blocked --json` and confirm it passes.");
  lines.push("- [ ] Re-run `npm run siteflow -- release-gate --promotion --env-file <target-env-file> --repo <owner/repo> --branch main --commit-ref <sha> --require-commit-status --json` with production evidence inputs.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeHumanResult(result: ReleaseCommitReadinessPlanResult, io: CliIo) {
  const output = result.errors.length > 0 ? io.stderr : io.stdout;

  output.write(`SiteFlow release commit readiness plan: ${result.status}\n`);
  output.write(`Tracked paths: ${result.trackedPathCount ?? "unknown"}\n`);
  output.write(`Forbidden tracked paths: ${result.forbiddenPathCount ?? "unknown"}\n`);
  output.write(`Critical untracked paths: ${result.criticalUntracked.total}\n`);
  output.write(`Untracked source paths: ${result.untrackedSource.total}\n`);
  output.write(`Tracked dirty source paths: ${result.trackedDirtySource.total}\n`);
  output.write(
    `Staging coverage: ${result.stagingCoverage.covered ? "covered" : "incomplete"} ` +
      `(${result.stagingCoverage.coveredRequiredPathCount}/${result.stagingCoverage.requiredPathCount} required path(s))\n`
  );

  for (const root of result.forbiddenRoots) {
    output.write(`- forbidden ${root.root}: ${root.count} path(s) - ${root.reason}\n`);
  }

  for (const finding of result.criticalUntracked.paths) {
    output.write(`- untracked ${finding.path}: ${finding.reason}\n`);
  }

  if (result.criticalUntracked.truncated) {
    output.write(`Additional critical untracked paths omitted: ${result.criticalUntracked.total - result.criticalUntracked.returned}\n`);
  }

  for (const finding of result.untrackedSource.paths) {
    output.write(`- untracked source ${finding.path}: ${finding.reason}\n`);
  }

  if (result.untrackedSource.truncated) {
    output.write(`Additional untracked source paths omitted: ${result.untrackedSource.total - result.untrackedSource.returned}\n`);
  }

  for (const finding of result.trackedDirtySource.paths) {
    output.write(`- tracked ${finding.status} ${finding.path}: ${finding.reason}\n`);
  }

  if (result.trackedDirtySource.truncated) {
    output.write(`Additional tracked dirty source paths omitted: ${result.trackedDirtySource.total - result.trackedDirtySource.returned}\n`);
  }

  for (const filePath of result.stagingCoverage.missingRequiredPaths) {
    output.write(`- missing staging pathspec ${filePath}\n`);
  }

  for (const filePath of result.stagingCoverage.excludedSuggestedPathspecs) {
    output.write(`- excluded staging pathspec ${filePath}\n`);
  }

  if (result.suggestedStagingGroups.length > 0) {
    output.write("Reviewed staging commands:\n");
    for (const group of result.suggestedStagingGroups) {
      output.write(`  ${group.command.display}\n`);
    }
  }

  for (const warning of result.warnings) {
    output.write(`Warning: ${warning}\n`);
  }
}

export async function runReleaseCommitReadinessPlanCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseCommitReadinessPlanOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseCommitReadinessPlanArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseCommitReadinessPlanUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseCommitReadinessPlanUsage()}\n`);
    return 0;
  }

  if (parsed.json && parsed.reviewChecklist && !parsed.reviewChecklistOutputPath) {
    io.stderr.write("--review-checklist cannot be combined with --json unless --review-checklist-output is also provided.\n\n");
    io.stderr.write(`${releaseCommitReadinessPlanUsage()}\n`);
    return 2;
  }

  const result = await runReleaseCommitReadinessPlan({
    ...baseOptions,
    rootDir: parsed.rootDir,
    outputPath: parsed.outputPath,
    maxFindings: parsed.maxFindings
  });
  const reviewChecklistPath = parsed.reviewChecklistOutputPath
    ? path.resolve(result.rootDir, parsed.reviewChecklistOutputPath)
    : undefined;

  if (reviewChecklistPath) {
    await writeFile(reviewChecklistPath, formatReleaseCommitReviewChecklist(result), "utf8");
  }

  if (parsed.json) {
    const output = result.errors.length > 0 ? io.stderr : io.stdout;
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (parsed.reviewChecklist) {
    const output = result.errors.length > 0 ? io.stderr : io.stdout;
    output.write(formatReleaseCommitReviewChecklist(result));
  } else {
    writeHumanResult(result, io);
  }

  if (result.exitCode !== 0) {
    return result.exitCode;
  }

  return parsed.failOnBlocked && result.status === "blocked" ? 1 : 0;
}

if (isEntrypoint()) {
  runReleaseCommitReadinessPlanCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
