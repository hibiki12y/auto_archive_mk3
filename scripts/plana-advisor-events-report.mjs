#!/usr/bin/env node
import { runPlanaAdvisorEventsReportCli } from '../dist/src/core/plana-advisor-events-report-cli.js';

process.exitCode = runPlanaAdvisorEventsReportCli(process.argv.slice(2));
