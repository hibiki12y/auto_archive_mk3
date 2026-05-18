#!/usr/bin/env node
import { runRuntimeDriverCheckCli } from '../dist/src/runtime/runtime-driver-check-cli.js';

process.exitCode = runRuntimeDriverCheckCli(process.argv.slice(2));
