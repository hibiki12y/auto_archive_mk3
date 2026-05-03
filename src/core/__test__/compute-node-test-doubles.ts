/**
 * Barrel module for ComputeNode test doubles.
 *
 * Test code SHOULD import from this module rather than from the
 * individual test-double files; this preserves the option to relocate
 * doubles in the future without churning every test importer (WU-P §3.3).
 *
 * Production modules MUST NOT import this barrel (C2 anti-scope, §6 Q3).
 */

export {
  InProcessComputeNode,
  type InProcessComputeNodeOptions,
} from './in-process-compute-node.js';
export {
  LocalComputeNode,
  type LocalComputeExecutor,
  type LocalComputeNodeOptions,
} from './local-compute-node.js';
