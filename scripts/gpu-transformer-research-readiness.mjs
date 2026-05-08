#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  buildGpuTransformerResearchReadinessReport,
  parseNvidiaSmiGpuCsv,
  renderGpuTransformerResearchReadinessReport,
} from '../dist/src/core/gpu-transformer-research-readiness.js';

const NVIDIA_SMI_QUERY_ARGS = [
  '--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,compute_cap',
  '--format=csv,noheader,nounits',
];

function usage() {
  return [
    'Usage: node scripts/gpu-transformer-research-readiness.mjs [options]',
    '',
    'Options:',
    '  --json                         Print JSON instead of Markdown text.',
    '  --write [path]                  Write JSON evidence. Default path is results/gpu-research-readiness/<timestamp>.json.',
    '  --input-file <path>             Read nvidia-smi CSV from a fixture instead of invoking nvidia-smi.',
    '  --min-free-memory-mib <int>     Default: 24576.',
    '  --max-utilization-percent <int> Default: 30.',
    '  --max-temperature-c <int>       Default: 85.',
    '  --min-compute-capability <x.y>  Default: 7.5.',
  ].join('\n');
}

function readOptionValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    json: false,
    write: false,
    writePath: undefined,
    inputFile: undefined,
    thresholds: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--write') {
      opts.write = true;
      const maybePath = argv[i + 1];
      if (maybePath !== undefined && !maybePath.startsWith('--')) {
        opts.writePath = maybePath;
        i += 1;
      }
      continue;
    }
    if (arg === '--input-file') {
      opts.inputFile = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--min-free-memory-mib') {
      opts.thresholds.minFreeMemoryMiB = parseNonNegativeInteger(
        readOptionValue(argv, i, arg),
        arg,
      );
      i += 1;
      continue;
    }
    if (arg === '--max-utilization-percent') {
      opts.thresholds.maxUtilizationGpuPercent = parseNonNegativeInteger(
        readOptionValue(argv, i, arg),
        arg,
      );
      i += 1;
      continue;
    }
    if (arg === '--max-temperature-c') {
      opts.thresholds.maxTemperatureC = parseNonNegativeInteger(
        readOptionValue(argv, i, arg),
        arg,
      );
      i += 1;
      continue;
    }
    if (arg === '--min-compute-capability') {
      opts.thresholds.minComputeCapability = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  return opts;
}

function defaultEvidencePath(generatedAt) {
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-');
  return `results/gpu-research-readiness/gpu-transformer-readiness-${safeTimestamp}.json`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const csv =
    opts.inputFile === undefined
      ? execFileSync('nvidia-smi', NVIDIA_SMI_QUERY_ARGS, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : readFileSync(opts.inputFile, 'utf8');
  const generatedAt = new Date().toISOString();
  const report = buildGpuTransformerResearchReadinessReport({
    gpus: parseNvidiaSmiGpuCsv(csv),
    thresholds: opts.thresholds,
    generatedAt,
    source: opts.inputFile === undefined ? 'nvidia-smi' : 'test-fixture',
  });
  if (opts.write) {
    const outputPath = resolve(opts.writePath ?? defaultEvidencePath(generatedAt));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`wrote GPU readiness evidence: ${outputPath}`);
  }
  console.log(
    opts.json
      ? JSON.stringify(report, null, 2)
      : renderGpuTransformerResearchReadinessReport(report),
  );
  process.exitCode = report.status === 'fail' ? 2 : report.status === 'warn' ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
