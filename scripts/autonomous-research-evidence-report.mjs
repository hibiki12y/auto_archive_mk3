#!/usr/bin/env node
import { runAutonomousResearchEvidenceReportCli } from '../dist/src/runtime/autonomous-research-evidence-report-cli.js';

process.exitCode = runAutonomousResearchEvidenceReportCli(process.argv.slice(2));
