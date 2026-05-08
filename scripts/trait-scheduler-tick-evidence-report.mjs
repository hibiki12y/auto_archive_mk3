#!/usr/bin/env node
import { runTraitSchedulerTickEvidenceReportCli } from '../dist/src/cron/trait-scheduler-evidence-report-cli.js';

process.exitCode = runTraitSchedulerTickEvidenceReportCli(process.argv.slice(2));
