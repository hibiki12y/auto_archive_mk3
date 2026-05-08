#!/usr/bin/env node
import { runPeekabooEvidenceReportCli } from '../dist/src/remote/peekaboo-evidence-report-cli.js';

process.exitCode = runPeekabooEvidenceReportCli(process.argv.slice(2));
