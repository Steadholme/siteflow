import { spawn } from "node:child_process";

/**
 * Loom (HOLDFAST git hosting) webhook dialect for the generic provider.
 *
 * Loom delivers webhooks with:
 *   X-Loom-Event:     push | issues | pull_request
 *   X-Loom-Delivery:  wd_<random>
 *   X-Loom-Signature: sha256=<hex HMAC-SHA256 of the raw body with the webhook secret>
 * (forge/crates/loom/src/webhooks.rs). The signature format and algorithm are
 * identical to SiteFlow's generic x-siteflow-signature — only header names differ,
 * so the generic endpoint accepts the X-Loom-* headers as fallbacks.
 *
 * The push payload is:
 *   { event, action, delivery, repository: { id, owner, name, full_name, private,
 *     default_branch }, sender: { subject }, pusher: { subject } }
 * It carries NO clone URL, NO branch ref and NO commit SHA, so this module maps it
 * into the generic webhook shape:
 *   - remoteUrl: <SITEFLOW_LOOM_CLONE_BASE_URL>/<owner>/<name>.git (anonymous
 *     PUBLIC smart-HTTP fetch; loom allows anonymous upload-pack on PUBLIC repos)
 *   - branch:    repository.default_branch (loom only reports "a push happened")
 *   - commitSha: resolved via `git ls-remote <remoteUrl> refs/heads/<branch>`
 *     (bounded, argv-vector spawn, no shell). Phase 2: extend loom's emit_push to
 *     include the after-SHA and drop the ls-remote hop.
 */

const loomNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const commitShaPattern = /^[a-f0-9]{40,64}$/i;
const defaultLsRemoteTimeoutMs = 10_000;

export interface LoomWebhookOptions {
  cloneBaseUrl?: string;
  resolveBranchTip?: (remoteUrl: string, branch: string) => Promise<string>;
}

function recordField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isLoomWebhookPayload(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }

  const record = payload as Record<string, unknown>;
  const repository = recordField(record, "repository");
  const sender = recordField(record, "sender");

  // Loom's distinguishing shape: repository.full_name + sender.subject, and no
  // generic-provider remoteUrl. A payload already in the generic shape is passed
  // through untouched.
  return Boolean(
    repository
    && stringField(repository, "full_name")
    && stringField(sender, "subject")
    && !stringField(repository, "remoteUrl")
    && !stringField(repository, "url")
  );
}

export async function resolveLoomBranchTip(remoteUrl: string, branch: string, timeoutMs = defaultLsRemoteTimeoutMs): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-remote", "--", remoteUrl, `refs/heads/${branch}`], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" }
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Loom branch tip resolution timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Loom branch tip resolution failed to start git: ${error.message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`Loom branch tip resolution failed (git ls-remote exit ${code}): ${stderr.trim().slice(0, 200)}`));
        return;
      }

      const sha = stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      if (!commitShaPattern.test(sha)) {
        reject(new Error(`Loom branch refs/heads/${branch} was not found on the remote.`));
        return;
      }

      resolve(sha);
    });
  });
}

/**
 * Transforms a Loom webhook payload into SiteFlow's generic webhook shape.
 * Throws with an operator-actionable message on any gap; the webhook handler
 * surfaces that as a 400.
 */
export async function loomPayloadToGeneric(payload: Record<string, unknown>, options: LoomWebhookOptions): Promise<Record<string, unknown>> {
  const cloneBaseUrl = options.cloneBaseUrl?.trim().replace(/\/+$/, "");

  if (!cloneBaseUrl) {
    throw new Error("SITEFLOW_LOOM_CLONE_BASE_URL is required to accept Loom webhooks.");
  }

  const repository = recordField(payload, "repository");
  const owner = stringField(repository, "owner");
  const name = stringField(repository, "name");

  if (!owner || !name || !loomNamePattern.test(owner) || !loomNamePattern.test(name)) {
    throw new Error("Loom webhook repository owner/name is missing or invalid.");
  }

  const defaultBranch = stringField(repository, "default_branch") ?? "main";
  const branch = stringField(payload, "branch") ?? defaultBranch;
  const remoteUrl = `${cloneBaseUrl}/${owner}/${name}.git`;
  const sender = stringField(recordField(payload, "sender"), "subject") ?? "loom";

  let commitSha = stringField(payload, "after") ?? stringField(payload, "commit_sha");

  if (!commitSha) {
    commitSha = await (options.resolveBranchTip ?? resolveLoomBranchTip)(remoteUrl, branch);
  }

  return {
    kind: stringField(payload, "event") ?? "push",
    branch,
    commitSha,
    commitMessage: stringField(payload, "commit_message") ?? `Loom push to ${owner}/${name}`,
    commitAuthor: sender,
    actor: {
      id: sender,
      name: sender
    },
    repository: {
      owner,
      name,
      defaultBranch,
      remoteUrl,
      webUrl: stringField(repository, "web_url")
    }
  };
}
