#!/usr/bin/env node
import { runTaskArchiveEvidenceReportCli } from '../dist/src/control/task-archive-evidence-report-cli.js';

process.exitCode = runTaskArchiveEvidenceReportCli(process.argv.slice(2));
