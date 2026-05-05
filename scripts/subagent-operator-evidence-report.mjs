#!/usr/bin/env node
import { runSubagentOperatorEvidenceReportCli } from '../dist/src/runtime/subagent-operator-evidence-report-cli.js';

process.exitCode = runSubagentOperatorEvidenceReportCli(process.argv.slice(2));
