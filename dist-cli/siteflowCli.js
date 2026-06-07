import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSingleHostInstallPlan, formatInstallPlan } from "./installPlan.js";
import { parseInstallState } from "./installState.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { deployPrebuilt, formatPrebuiltDeployResult } from "./deploy.js";
const lifecycleCommands = new Set(["backup", "restore", "upgrade", "uninstall", "logs"]);
function parseArgs(argv) {
    const [command, ...rest] = argv;
    const flags = {};
    const positionals = [];
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const [rawName, inlineValue] = arg.slice(2).split("=", 2);
        const next = rest[index + 1];
        if (inlineValue !== undefined) {
            flags[rawName] = inlineValue;
            continue;
        }
        if (next && !next.startsWith("--")) {
            flags[rawName] = next;
            index += 1;
            continue;
        }
        flags[rawName] = true;
    }
    return { command, flags, positionals };
}
function flagString(flags, name) {
    const value = flags[name];
    return typeof value === "string" ? value : undefined;
}
function flagBoolean(flags, name) {
    return flags[name] === true || flags[name] === "true" || flags[name] === "1";
}
function writeJson(io, value) {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}
function helpText() {
    return [
        "SiteFlow CLI",
        "",
        "Usage:",
        "  siteflow install --topology single --dry-run [--domain app.example.com] [--json]",
        "  siteflow deploy --prebuilt ./dist --server https://siteflow.example.com --project my-app --base-domain w33d.xyz [--json]",
        "  siteflow doctor [--json]",
        "  siteflow status [--state /etc/siteflow/install-state.json] [--json]",
        "",
        "Commands:",
        "  install     Plan or apply a SiteFlow server installation.",
        "  deploy      Upload a prebuilt static artifact and create a preview URL.",
        "  doctor      Validate host and SiteFlow runtime readiness.",
        "  status      Read the install-state manifest and print installed version/topology.",
        "  backup      Reserved lifecycle command.",
        "  restore     Reserved lifecycle command.",
        "  upgrade     Reserved lifecycle command.",
        "  uninstall   Reserved lifecycle command.",
        "  logs        Reserved lifecycle command."
    ].join("\n");
}
async function runStatus(parsed, io) {
    const statePath = flagString(parsed.flags, "state") ?? "/etc/siteflow/install-state.json";
    const json = flagBoolean(parsed.flags, "json");
    try {
        const state = parseInstallState(JSON.parse(await readFile(statePath, "utf8")));
        if (json) {
            writeJson(io, {
                status: "installed",
                statePath,
                siteflowVersion: state.siteflowVersion,
                topology: state.topology,
                services: state.services,
                router: state.router
            });
            return 0;
        }
        io.stdout(`SiteFlow ${state.siteflowVersion} (${state.topology})\nState: ${statePath}\n`);
        return 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read install state.";
        if (json) {
            writeJson(io, { status: "not_installed", statePath, message });
        }
        else {
            io.stderr(`SiteFlow is not installed or state is unreadable: ${message}\n`);
        }
        return 1;
    }
}
export async function runSiteFlowCli(argv, io, dependencies = {}) {
    const parsed = parseArgs(argv);
    const json = flagBoolean(parsed.flags, "json");
    const version = dependencies.version ?? "0.1.0";
    const env = dependencies.env ?? process.env;
    if (!parsed.command || parsed.command === "--help" || parsed.command === "help" || flagBoolean(parsed.flags, "help")) {
        io.stdout(`${helpText()}\n`);
        return 0;
    }
    if (parsed.command === "doctor") {
        const report = await runDoctor(dependencies.doctor);
        if (json) {
            writeJson(io, report);
        }
        else {
            io.stdout(`${formatDoctorReport(report)}\n`);
        }
        return report.status === "fail" ? 1 : 0;
    }
    if (parsed.command === "install") {
        const dryRun = flagBoolean(parsed.flags, "dry-run");
        const topology = flagString(parsed.flags, "topology") ?? "single";
        const domain = flagString(parsed.flags, "domain");
        if (!dryRun) {
            const message = "Install apply is not implemented in this slice. Run with --dry-run to inspect the production install plan.";
            if (json) {
                writeJson(io, { status: "blocked", message });
            }
            else {
                io.stderr(`${message}\n`);
            }
            return 2;
        }
        try {
            const plan = createSingleHostInstallPlan({ topology: topology, domain, version });
            if (json) {
                writeJson(io, plan);
            }
            else {
                io.stdout(`${formatInstallPlan(plan)}\n`);
            }
            return 0;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Install planning failed.";
            if (json) {
                writeJson(io, { status: "failed", message });
            }
            else {
                io.stderr(`${message}\n`);
            }
            return 1;
        }
    }
    if (parsed.command === "deploy") {
        const prebuilt = flagString(parsed.flags, "prebuilt") ?? parsed.positionals[0];
        const serverUrl = flagString(parsed.flags, "server") ?? env.SITEFLOW_API_URL;
        const baseDomain = flagString(parsed.flags, "base-domain") ?? env.SITEFLOW_BASE_DOMAIN;
        const projectSlug = flagString(parsed.flags, "project") ?? (prebuilt ? path.basename(path.resolve(prebuilt)) : undefined);
        const entrypoint = flagString(parsed.flags, "entrypoint") ?? "index.html";
        const requestedHostPrefix = flagString(parsed.flags, "host-prefix");
        if (!prebuilt || !serverUrl || !baseDomain || !projectSlug) {
            const message = "Deploy requires --prebuilt, --server, --project, and --base-domain.";
            if (json) {
                writeJson(io, { status: "failed", message });
            }
            else {
                io.stderr(`${message}\n`);
            }
            return 1;
        }
        try {
            const result = await deployPrebuilt({
                directory: prebuilt,
                serverUrl,
                projectSlug,
                baseDomain,
                entrypoint,
                requestedHostPrefix,
                fetch: dependencies.fetch
            });
            if (json) {
                writeJson(io, result);
            }
            else {
                io.stdout(`${formatPrebuiltDeployResult(result)}\n`);
            }
            return 0;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Prebuilt deploy failed.";
            if (json) {
                writeJson(io, { status: "failed", message });
            }
            else {
                io.stderr(`${message}\n`);
            }
            return 1;
        }
    }
    if (parsed.command === "status") {
        return runStatus(parsed, io);
    }
    if (lifecycleCommands.has(parsed.command)) {
        const message = `${parsed.command} is reserved for the lifecycle implementation phase.`;
        if (json) {
            writeJson(io, { status: "reserved", command: parsed.command, message });
        }
        else {
            io.stderr(`${message}\n`);
        }
        return 2;
    }
    io.stderr(`Unknown command: ${parsed.command}\n\n${helpText()}\n`);
    return 1;
}
