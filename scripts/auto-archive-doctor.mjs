#!/usr/bin/env node
import { buildDoctorReportFromEnv, renderDoctorReport } from '../dist/src/core/doctor.js';

console.log(renderDoctorReport(buildDoctorReportFromEnv(process.env)));
