import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
const defaultRunner = async () => ({
    exitCode: 0,
    stdout: "",
    stderr: ""
});
function mapPath(filePath, root) {
    if (!root || !path.isAbsolute(filePath)) {
        return filePath;
    }
    const normalized = filePath.replace(/^[a-zA-Z]:/, "").replace(/^[/\\]+/, "");
    return path.join(root, normalized);
}
function nginxAvailablePath(plan) {
    return plan.installState.router.nginxAvailablePath ?? "/etc/nginx/sites-available/siteflow.conf";
}
function nginxEnabledPath(plan) {
    return plan.installState.router.nginxEnabledPath ?? "/etc/nginx/sites-enabled/siteflow.conf";
}
function aggregateDoctorStatus(checks) {
    if (checks.some((check) => check.status === "fail")) {
        return "fail";
    }
    if (checks.some((check) => check.status === "warn")) {
        return "warn";
    }
    return "pass";
}
async function tryReadText(filePath) {
    return readFile(filePath, "utf8").catch((error) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
}
async function writeTextAsset(asset, root, stepId) {
    const targetPath = mapPath(asset.path, root);
    const existing = await tryReadText(targetPath);
    if (existing === asset.content) {
        return {
            id: stepId,
            status: "skipped",
            summary: `${asset.path} is unchanged.`,
            path: asset.path
        };
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, asset.content, "utf8");
    await rm(targetPath, { force: true });
    await rename(tempPath, targetPath);
    return {
        id: stepId,
        status: existing === undefined ? "created" : "updated",
        summary: `${asset.path} rendered.`,
        path: asset.path
    };
}
async function writeSecretFile(secret, root) {
    const targetPath = mapPath(secret.path, root);
    const existing = await tryReadText(targetPath);
    if (existing?.trim()) {
        await chmod(targetPath, 0o600).catch(() => undefined);
        return {
            id: `secret.${secret.id}`,
            status: "skipped",
            summary: `${secret.path} already exists and was reused.`,
            path: secret.path
        };
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${randomBytes(secret.byteLength).toString("base64url")}\n`, {
        encoding: "utf8",
        mode: 0o600
    });
    return {
        id: `secret.${secret.id}`,
        status: "created",
        summary: `${secret.path} was generated.`,
        path: secret.path
    };
}
async function snapshotPath(filePath) {
    const stat = await lstat(filePath).catch((error) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    if (!stat) {
        return { exists: false };
    }
    if (stat.isSymbolicLink()) {
        const linkTarget = await import("node:fs/promises").then((fs) => fs.readlink(filePath));
        return { exists: true, kind: "symlink", linkTarget };
    }
    return {
        exists: true,
        kind: "file",
        content: await readFile(filePath, "utf8")
    };
}
async function restorePath(filePath, snapshot) {
    await rm(filePath, { force: true });
    if (!snapshot.exists) {
        return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    if (snapshot.kind === "symlink" && snapshot.linkTarget) {
        await symlink(snapshot.linkTarget, filePath);
        return;
    }
    await writeFile(filePath, snapshot.content ?? "", "utf8");
}
async function writeNginxEnabled(enabledPath, availablePath, content, linkStrategy) {
    await mkdir(path.dirname(enabledPath), { recursive: true });
    await rm(enabledPath, { force: true });
    if (linkStrategy === "copy") {
        await writeFile(enabledPath, content, "utf8");
        return;
    }
    await symlink(availablePath, enabledPath);
}
async function runChecked(runner, command, args, failureMessage) {
    const result = await runner(command, args);
    if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`.trim();
        throw new Error(output ? `${failureMessage}: ${output}` : failureMessage);
    }
    return {
        id: `${command}.${args.join(".") || "run"}`,
        status: "validated",
        summary: `${command} ${args.join(" ")} succeeded.`.trim()
    };
}
function passCheck(id, label, summary) {
    return {
        id,
        label,
        status: "pass",
        summary
    };
}
function failCheck(id, label, summary, remediation) {
    return {
        id,
        label,
        status: "fail",
        summary,
        remediation
    };
}
async function checkTextAsset(asset, root, id, label) {
    const content = await tryReadText(mapPath(asset.path, root));
    if (content === asset.content) {
        return passCheck(id, label, `${asset.path} matches the rendered SiteFlow asset.`);
    }
    return failCheck(id, label, `${asset.path} does not match the rendered SiteFlow asset.`, "Re-run siteflow install --yes to re-render the file.");
}
function apiPort(plan) {
    const port = Number(plan.runtimeEnv.SITEFLOW_API_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Install plan has an invalid SITEFLOW_API_PORT.");
    }
    return port;
}
function healthUrl(plan) {
    return `http://127.0.0.1:${apiPort(plan)}/healthz`;
}
function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
async function waitForApiHealth(plan, options) {
    const url = healthUrl(plan);
    const fetchImpl = options.fetch ?? fetch;
    const attempts = options.healthAttempts ?? 30;
    const intervalMs = options.healthIntervalMs ?? 1000;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchImpl(url, {
                headers: {
                    accept: "application/json"
                }
            });
            if (response.ok) {
                const body = (await response.json().catch(() => undefined));
                if (!body || body.status === "ok") {
                    return {
                        id: "api.health",
                        status: "validated",
                        summary: `SiteFlow API health check passed at ${url}.`
                    };
                }
                lastError = `unexpected health status ${body.status}`;
            }
            else {
                lastError = `HTTP ${response.status}`;
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : "health request failed";
        }
        if (attempt < attempts && intervalMs > 0) {
            await sleep(intervalMs);
        }
    }
    throw new Error(`SiteFlow API did not become healthy at ${url}: ${lastError || "no successful response"}.`);
}
async function runInstallDoctor(plan, options) {
    const checks = [];
    const runner = options.runner ?? defaultRunner;
    if (options.startServices ?? true) {
        const serviceName = plan.installState.services.unit ?? "siteflow.service";
        const result = await runner("systemctl", ["is-active", serviceName]);
        const output = `${result.stdout}\n${result.stderr}`.trim();
        checks.push(result.exitCode === 0
            ? passCheck("service.active", "SiteFlow service", output || `${serviceName} is active.`)
            : failCheck("service.active", "SiteFlow service", output || `${serviceName} is not active.`, `Run systemctl status ${serviceName}.`));
    }
    checks.push(await checkTextAsset(plan.renderedAssets.env, options.root, "asset.env", "Runtime env file"));
    checks.push(await checkTextAsset(plan.renderedAssets.compose, options.root, "asset.compose", "Compose file"));
    checks.push(await checkTextAsset(plan.renderedAssets.systemd, options.root, "asset.systemd", "systemd unit"));
    for (const secret of plan.secrets) {
        const content = await tryReadText(mapPath(secret.path, options.root));
        checks.push(content?.trim()
            ? passCheck(`secret.${secret.id}`, secret.description, `${secret.path} exists and is non-empty.`)
            : failCheck(`secret.${secret.id}`, secret.description, `${secret.path} is missing or empty.`, "Re-run siteflow install --yes to generate missing secrets."));
    }
    const artifactRoot = mapPath(plan.installState.storage.artifactRoot ?? `${plan.installState.paths.dataDir}/artifacts`, options.root);
    const probePath = path.join(artifactRoot, `.siteflow-install-probe-${process.pid}-${Date.now()}`);
    try {
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(probePath, "siteflow-artifact-probe\n", "utf8");
        const probe = await readFile(probePath, "utf8");
        await rm(probePath, { force: true });
        checks.push(probe === "siteflow-artifact-probe\n"
            ? passCheck("storage.artifactRoot", "Artifact storage", `${plan.installState.storage.artifactRoot} is writable and readable.`)
            : failCheck("storage.artifactRoot", "Artifact storage", `${plan.installState.storage.artifactRoot} returned unexpected probe content.`));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "artifact probe failed";
        checks.push(failCheck("storage.artifactRoot", "Artifact storage", message, "Check ownership and permissions for the artifact root."));
    }
    if (plan.renderedAssets.nginx) {
        const activeConfig = await tryReadText(mapPath(nginxEnabledPath(plan), options.root));
        checks.push(activeConfig === plan.renderedAssets.nginx.content
            ? passCheck("router.nginxActive", "Active Nginx config", `${nginxEnabledPath(plan)} matches the generated SiteFlow config.`)
            : failCheck("router.nginxActive", "Active Nginx config", `${nginxEnabledPath(plan)} does not match the generated SiteFlow config.`, "Re-run siteflow install --yes and check nginx -t output."));
    }
    return {
        status: aggregateDoctorStatus(checks),
        checks
    };
}
function doctorStep(report) {
    const failed = report.checks.filter((check) => check.status === "fail");
    if (failed.length > 0) {
        return {
            id: "install.doctor",
            status: "failed",
            summary: `${failed.length} install doctor check(s) failed.`
        };
    }
    return {
        id: "install.doctor",
        status: "validated",
        summary: `${report.checks.length} install doctor check(s) passed.`
    };
}
async function ensureDirectories(plan, root) {
    const directories = [
        plan.installState.paths.installDir,
        plan.installState.paths.configDir,
        plan.installState.paths.dataDir,
        plan.installState.paths.backupDir,
        plan.installState.storage.artifactRoot,
        path.dirname(plan.renderedAssets.compose.path),
        path.dirname(plan.renderedAssets.systemd.path),
        path.dirname(plan.renderedAssets.env.path),
        plan.renderedAssets.nginx ? path.dirname(plan.renderedAssets.nginx.path) : undefined,
        plan.renderedAssets.nginx ? path.dirname(nginxAvailablePath(plan)) : undefined,
        plan.renderedAssets.nginx ? path.dirname(nginxEnabledPath(plan)) : undefined
    ].filter((value) => Boolean(value));
    for (const directory of directories) {
        await mkdir(mapPath(directory, root), { recursive: true });
    }
    return {
        id: "directories",
        status: "created",
        summary: "Install, config, data, backup, artifact, and router directories are present."
    };
}
async function applyServiceAssets(plan, options) {
    const steps = [];
    for (const secret of plan.secrets) {
        steps.push(await writeSecretFile(secret, options.root));
    }
    steps.push(await writeTextAsset(plan.renderedAssets.compose, options.root, "compose"));
    steps.push(await writeTextAsset(plan.renderedAssets.systemd, options.root, "systemd"));
    if (options.startServices) {
        const runner = options.runner ?? defaultRunner;
        steps.push(await runChecked(runner, "systemctl", ["daemon-reload"], "systemd daemon reload failed"));
        steps.push(await runChecked(runner, "systemctl", ["enable", "--now", plan.installState.services.unit ?? "siteflow.service"], "SiteFlow service start failed"));
        if (options.waitForHealth ?? true) {
            steps.push(await waitForApiHealth(plan, options));
        }
    }
    return steps;
}
async function applyNginx(plan, options) {
    const nginx = plan.renderedAssets.nginx;
    if (!nginx) {
        return [];
    }
    const steps = [];
    steps.push(await writeTextAsset(nginx, options.root, "nginx.staging"));
    const availableSource = {
        ...nginx,
        path: nginxAvailablePath(plan)
    };
    const availablePath = mapPath(availableSource.path, options.root);
    const enabledPath = mapPath(nginxEnabledPath(plan), options.root);
    const availableSnapshot = await snapshotPath(availablePath);
    const enabledSnapshot = await snapshotPath(enabledPath);
    try {
        steps.push(await writeTextAsset(availableSource, options.root, "nginx.available"));
        await writeNginxEnabled(enabledPath, availablePath, nginx.content, options.linkStrategy);
        steps.push({
            id: "nginx.enabled",
            status: enabledSnapshot.exists ? "updated" : "created",
            summary: `${nginxEnabledPath(plan)} points at the generated SiteFlow config.`,
            path: nginxEnabledPath(plan)
        });
        steps.push(await runChecked(options.runner ?? defaultRunner, "nginx", ["-t"], "Nginx validation failed"));
        if (options.reloadNginx) {
            steps.push(await runChecked(options.runner ?? defaultRunner, "nginx", ["-s", "reload"], "Nginx reload failed"));
        }
    }
    catch (error) {
        await restorePath(availablePath, availableSnapshot);
        await restorePath(enabledPath, enabledSnapshot);
        steps.push({
            id: "nginx.rollback",
            status: "failed",
            summary: "Nginx apply failed; previous known-good files were restored."
        });
        throw error;
    }
    return steps;
}
export async function applyInstallPlan(plan, options = {}) {
    const steps = [];
    const linkStrategy = options.linkStrategy ?? "symlink";
    const reloadNginx = options.reloadNginx ?? true;
    const startServices = options.startServices ?? true;
    steps.push(await ensureDirectories(plan, options.root));
    steps.push(await writeTextAsset(plan.renderedAssets.env, options.root, "env"));
    steps.push(...(await applyServiceAssets(plan, { ...options, startServices })));
    steps.push(...(await applyNginx(plan, { ...options, linkStrategy, reloadNginx })));
    const doctor = options.runFinalDoctor === false ? { status: "pass", checks: [] } : await runInstallDoctor(plan, { ...options, startServices });
    const doctorApplyStep = doctorStep(doctor);
    steps.push(doctorApplyStep);
    if (doctor.status === "fail") {
        throw new Error(doctorApplyStep.summary);
    }
    const nginxChecksum = plan.renderedAssets.nginx?.checksum.replace(/^sha256:/, "");
    const activeRevision = nginxChecksum ? `nginx-rev-${nginxChecksum.slice(0, 12)}` : undefined;
    const statePath = `${plan.installState.paths.configDir}/install-state.json`;
    const installState = {
        ...plan.installState,
        router: {
            ...plan.installState.router,
            activeRevision
        },
        lastOperation: {
            id: `install-${Date.now()}`,
            type: "install",
            status: "succeeded"
        }
    };
    steps.push(await writeTextAsset({
        path: statePath,
        checksum: "",
        content: `${JSON.stringify(installState, null, 2)}\n`
    }, options.root, "install-state"));
    return {
        status: "installed",
        statePath,
        steps,
        doctor,
        router: installState.router
    };
}
