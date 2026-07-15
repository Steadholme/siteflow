import type { BuildJobResult, QueuedBuildJob } from "./buildWorker.js";

/**
 * Steadholme Klaxon notification client (fire-and-forget, estate convention):
 * - enabled ONLY when both KLAXON_NOTIFY_URL and KLAXON_INGEST_TOKEN are set;
 * - 5s timeout, detached, failures are logged as warnings and NEVER block or
 *   fail the build pipeline;
 * - payload contract mirrors forge/crates/loom/src/notify.rs:
 *   POST { user_sub, source, severity, title, body, url } with Bearer token.
 */

const notifyTimeoutMs = 5_000;
const notifySource = "siteflow";

export interface BuildEventNotification {
  status: "succeeded" | "failed";
  job: QueuedBuildJob;
  result?: BuildJobResult;
  reason?: string;
}

export type BuildEventNotifier = (event: BuildEventNotification) => void;

interface KlaxonNotifierEnv {
  KLAXON_NOTIFY_URL?: string;
  KLAXON_INGEST_TOKEN?: string;
}

function truncated(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function createKlaxonBuildNotifier(
  env: KlaxonNotifierEnv = process.env,
  options: { fetchImpl?: typeof fetch; warn?: (message: string) => void } = {}
): BuildEventNotifier | undefined {
  const url = env.KLAXON_NOTIFY_URL?.trim();
  const token = env.KLAXON_INGEST_TOKEN?.trim();

  if (!url || !token) {
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  return (event) => {
    const userSub = event.job.sourceEvent.actor?.id?.trim();

    // Klaxon delivers to an estate user subject (e.g. "w33d", "usr_alice").
    // Synthetic namespaced actors ("deploy-hook:dh_1", "api-token:resolved")
    // and system actors have no estate inbox, so those builds do not notify.
    if (!userSub || userSub.includes(":") || event.job.sourceEvent.actor?.role === "system") {
      return;
    }

    const project = event.job.projectSlug;
    const branch = event.job.sourceEvent.branch;
    const shortSha = event.job.sourceEvent.commitSha.slice(0, 12);
    const payload = {
      user_sub: userSub,
      source: notifySource,
      severity: event.status === "succeeded" ? "info" : "warning",
      title: event.status === "succeeded"
        ? `Deploy succeeded: ${project}`
        : `Deploy failed: ${project}`,
      body: event.status === "succeeded"
        ? `${project} @ ${branch} (${shortSha}) built and deployed.`
        : truncated(`${project} @ ${branch} (${shortSha}) build failed: ${event.reason ?? "unknown error"}`, 500),
      url: event.result?.previewUrl ?? ""
    };

    void (async () => {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(notifyTimeoutMs)
        });

        if (!response.ok) {
          warn(`SiteFlow klaxon notify failed: HTTP ${response.status}`);
        }
      } catch (error) {
        warn(`SiteFlow klaxon notify failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    })();
  };
}
