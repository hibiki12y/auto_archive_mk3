import {
  createExecutionCheckpoint,
  type ExecutionCheckpoint,
} from '../contracts/execution-checkpoint.js';
import type { DispatchPlan } from './task.js';
import {
  GitCommandClient,
  type GitClient,
  type GitCommandOptions,
} from './git-command-client.js';

export const AUTO_ARCHIVE_GITLAB_REPOSITORY_URL =
  'AUTO_ARCHIVE_GITLAB_REPOSITORY_URL';
export const AUTO_ARCHIVE_GITLAB_REVISION = 'AUTO_ARCHIVE_GITLAB_REVISION';

export interface ExecutionCheckpointPublisher {
  publish(
    plan: DispatchPlan,
    options?: GitCommandOptions,
  ): Promise<ExecutionCheckpoint>;
}

export interface GitLabCheckpointDriverOptions {
  gitClient?: GitClient;
}

export class GitLabCheckpointDriver implements ExecutionCheckpointPublisher {
  private readonly gitClient: GitClient;

  constructor(options: GitLabCheckpointDriverOptions = {}) {
    this.gitClient = options.gitClient ?? new GitCommandClient();
  }

  async publish(
    _plan: DispatchPlan,
    options: GitCommandOptions = {},
  ): Promise<ExecutionCheckpoint> {
    const repositoryRoot = await this.gitClient.getRepoTopLevel(options);
    const repositoryUrlOverride =
      process.env[AUTO_ARCHIVE_GITLAB_REPOSITORY_URL];
    const revisionOverride = process.env[AUTO_ARCHIVE_GITLAB_REVISION];
    const revision =
      revisionOverride ?? (await this.gitClient.getHeadRevision(options));
    const originUrl =
      repositoryUrlOverride ?? (await this.gitClient.getOriginUrl(options));

    return createExecutionCheckpoint({
      source: originUrl === undefined ? 'local-repo' : 'gitlab',
      repositoryUrl: originUrl ?? repositoryRoot,
      revision,
      publishedAt: new Date().toISOString(),
    });
  }
}
