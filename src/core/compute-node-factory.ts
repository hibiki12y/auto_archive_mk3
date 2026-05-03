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
 */
export function createDefaultComputeNode(
  options: DefaultComputeNodeOptions = {},
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
