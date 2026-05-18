#!/usr/bin/env node
import { runAgentEventsReportCli } from '../dist/src/runtime/agent-events-report-cli.js';

process.exitCode = runAgentEventsReportCli(process.argv.slice(2));
