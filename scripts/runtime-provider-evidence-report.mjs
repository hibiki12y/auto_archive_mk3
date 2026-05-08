#!/usr/bin/env node
import { runRuntimeProviderEvidenceReportCli } from '../dist/src/runtime/runtime-provider-evidence-report-cli.js';

process.exitCode = runRuntimeProviderEvidenceReportCli(process.argv.slice(2));
