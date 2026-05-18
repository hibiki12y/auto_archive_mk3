#!/usr/bin/env node
import { runResearchPlanCheckCli } from '../dist/src/core/research-plan-check-cli.js';

process.exitCode = runResearchPlanCheckCli(process.argv.slice(2));
