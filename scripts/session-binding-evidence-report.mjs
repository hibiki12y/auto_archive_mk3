#!/usr/bin/env node
import { runSessionBindingEvidenceReportCli } from '../dist/src/discord/session-binding-evidence-report-cli.js';

process.exitCode = runSessionBindingEvidenceReportCli(process.argv.slice(2));
