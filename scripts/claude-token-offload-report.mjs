#!/usr/bin/env node
import { runClaudeOffloadReportCli } from '../dist/src/core/claude-token-offload-report-cli.js';

process.exitCode = runClaudeOffloadReportCli(process.argv.slice(2));
