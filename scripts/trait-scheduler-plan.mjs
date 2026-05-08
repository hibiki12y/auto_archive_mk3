#!/usr/bin/env node
import { runTraitSchedulerPlanCli } from '../dist/src/index.js';

process.exitCode = runTraitSchedulerPlanCli(process.argv.slice(2));
