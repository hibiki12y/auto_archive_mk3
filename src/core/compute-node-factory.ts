import {
  CurrentNodeComputeNode,
  type CurrentNodeComputeNodeOptions,
} from './current-node-compute-node.js';
import { SlurmApptainerComputeNode } from './compute-node-slurm-apptainer.js';
import {
  GitLabCloneComputeNode,
  type GitLabCloneComputeNodeOptions,
} from './gitlab-clone-compute-node.js';
import type { ComputeNode } from './compute-node.js';

export const AUTO_ARCHIVE_COMPUTE_NODE = 'AUTO_ARCHIVE_COMPUTE_NODE';

export interface DefaultComputeNodeOptions
  extends GitLabCloneComputeNodeOptions,
    CurrentNodeComputeNodeOptions {}

/**
 * Production default compute-node resolution.
 *
 * Behaviour by `AUTO_ARCHIVE_COMPUTE_NODE`:
 *   - unset / `''` / `'slurm-apptainer'` -> `SlurmApptainerComputeNode`
 *   - `'git-clone'` -> `GitLabCloneComputeNode`
 *   - `'current-node'` -> `CurrentNodeComputeNode`
 *
 * `options.runtime` is the host-side runtime port both the `git-clone`
 * and `current-node` backends require. SlurmApptainer dispatches into a
 * separate process (apptainer container) so it does not consume the
 * host-side runtime — the caller still has to construct it because it
 * is layered above the factory in the dependency graph and the factory
 * MUST NOT default-construct AgentRuntime in the domain layer (that
 * was the historical leak that pulled CodexRuntimeDriver into core/).
 */
export function createDefaultComputeNode(
  options: DefaultComputeNodeOptions,
): ComputeNode {
  const nodeMode = process.env[AUTO_ARCHIVE_COMPUTE_NODE];

  if (nodeMode === 'git-clone') {
    return new GitLabCloneComputeNode(options);
  }

  if (nodeMode === 'current-node') {
    return new CurrentNodeComputeNode(options);
  }

  if (
    nodeMode === undefined ||
    nodeMode === '' ||
    nodeMode === 'slurm-apptainer'
  ) {
    return new SlurmApptainerComputeNode();
  }

  throw new Error(
    `Unsupported ${AUTO_ARCHIVE_COMPUTE_NODE} value: ${nodeMode}`,
  );
}
