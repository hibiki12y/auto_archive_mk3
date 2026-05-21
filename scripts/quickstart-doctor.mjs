#!/usr/bin/env node
import { runQuickstartDoctorCli } from '../dist/src/core/quickstart-doctor.js';

process.exitCode = runQuickstartDoctorCli(process.argv.slice(2));
