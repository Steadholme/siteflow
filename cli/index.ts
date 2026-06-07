#!/usr/bin/env node
import { runSiteFlowCli } from "./siteflowCli.js";

const exitCode = await runSiteFlowCli(process.argv.slice(2), {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message)
});

process.exitCode = exitCode;

