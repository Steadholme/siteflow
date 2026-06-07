import { execFile } from "node:child_process";
import os from "node:os";
export const defaultCommandRunner = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
        const commandError = error;
        const exitCode = typeof commandError?.code === "number" ? Number(commandError.code) : commandError ? 1 : 0;
        resolve({ exitCode, stdout, stderr });
    });
});
function aggregateStatus(checks) {
    if (checks.some((check) => check.status === "fail")) {
        return "fail";
    }
    if (checks.some((check) => check.status === "warn")) {
        return "warn";
    }
    return "pass";
}
async function commandCheck(id, label, command, args, runner) {
    const result = await runner(command, args);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode === 0) {
        return {
            id,
            label,
            status: "pass",
            summary: output || `${command} is available.`
        };
    }
    return {
        id,
        label,
        status: "fail",
        summary: `${command} is not available or returned exit code ${result.exitCode}.`,
        remediation: `Install ${command} and make sure it is available on PATH.`
    };
}
export async function runDoctor(options = {}) {
    const platform = options.platform ?? os.platform();
    const arch = options.arch ?? os.arch();
    const runner = options.runner ?? defaultCommandRunner;
    const checks = [
        {
            id: "host.os",
            label: "Operating system",
            status: platform === "linux" ? "pass" : "warn",
            summary: platform === "linux"
                ? "Linux host detected."
                : `Current platform is ${platform}. Production install targets Linux; this host can only run planning and client-side checks.`
        },
        {
            id: "host.arch",
            label: "CPU architecture",
            status: arch === "x64" || arch === "arm64" ? "pass" : "warn",
            summary: `Detected ${arch}. Supported production architectures are x64 and arm64.`
        },
        {
            id: "host.node",
            label: "Node.js runtime",
            status: "pass",
            summary: `Node.js ${process.version} is available for the CLI.`
        }
    ];
    checks.push(await commandCheck("runtime.docker", "Docker runtime", "docker", ["--version"], runner));
    checks.push(await commandCheck("router.nginx", "Nginx", "nginx", ["-v"], runner));
    return {
        status: aggregateStatus(checks),
        checks
    };
}
export function formatDoctorReport(report) {
    const lines = [`SiteFlow doctor: ${report.status.toUpperCase()}`];
    for (const check of report.checks) {
        lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.summary}`);
        if (check.remediation) {
            lines.push(`  Remediation: ${check.remediation}`);
        }
    }
    return lines.join("\n");
}
