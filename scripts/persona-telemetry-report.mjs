#!/usr/bin/env node
import { runPersonaTelemetryReportCli } from '../dist/src/persona/persona-telemetry-report-cli.js';

process.exitCode = runPersonaTelemetryReportCli(process.argv.slice(2));
