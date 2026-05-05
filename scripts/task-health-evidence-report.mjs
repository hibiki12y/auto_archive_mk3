#!/usr/bin/env node
import { runTaskHealthEvidenceReportCli } from '../dist/src/control/task-health-evidence-report-cli.js';

process.exitCode = runTaskHealthEvidenceReportCli(process.argv.slice(2));
