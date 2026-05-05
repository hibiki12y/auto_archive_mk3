#!/usr/bin/env node
import { runAgentHarnessRegistryReportCli } from '../dist/src/runtime/agent-harness-registry-report-cli.js';

process.exitCode = runAgentHarnessRegistryReportCli(process.argv.slice(2));
