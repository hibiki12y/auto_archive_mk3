#!/usr/bin/env node
import { runLiveProofReportCli } from '../dist/src/core/live-proof-report-cli.js';

process.exitCode = runLiveProofReportCli(process.argv.slice(2));
