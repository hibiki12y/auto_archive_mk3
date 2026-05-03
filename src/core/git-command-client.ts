import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export interface GitClient {
  getRepoTopLevel(options?: GitCommandOptions): Promise<string>;
  getHeadRevision(options?: GitCommandOptions): Promise<string>;
  getOriginUrl(options?: GitCommandOptions): Promise<string | undefined>;
  clone(
    repositoryUrl: string,
    destination: string,
    options?: GitCommandOptions,
  ): Promise<void>;
  checkoutDetach(revision: string, options?: GitCommandOptions): Promise<void>;
}

export class GitCommandError extends Error {
  readonly name = 'GitCommandError';

  constructor(
    readonly args: readonly string[],
    readonly cwd: string | undefined,
    readonly exitCode: number | undefined,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
  }
}

function describeGitFailure(error: unknown): {
  exitCode: number | undefined;
  stderr: string;
  message: string;
} {
  if (error instanceof Error) {
    const exitCode =
      typeof (error as { code?: unknown }).code === 'number'
        ? ((error as { code?: number }).code ?? undefined)
        : undefined;
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (((error as { stderr?: string }).stderr as string) ?? '')
        : '';
    return {
      exitCode,
      stderr,
      message: error.message,
    };
  }

  return {
    exitCode: undefined,
    stderr: '',
    message: `non-Error git failure: ${String(error)}`,
  };
}

async function runGit(
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: options.cwd,
      signal: options.signal,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = describeGitFailure(error);
    throw new GitCommandError(
      args,
      options.cwd,
      failure.exitCode,
      failure.stderr,
      `git ${args.join(' ')} failed: ${failure.message}`,
    );
  }
}

export class GitCommandClient implements GitClient {
  async getRepoTopLevel(options: GitCommandOptions = {}): Promise<string> {
    return runGit(['rev-parse', '--show-toplevel'], options);
  }

  async getHeadRevision(options: GitCommandOptions = {}): Promise<string> {
    return runGit(['rev-parse', 'HEAD'], options);
  }

  async getOriginUrl(options: GitCommandOptions = {}): Promise<string | undefined> {
    try {
      const originUrl = await runGit(
        ['config', '--get', 'remote.origin.url'],
        options,
      );
      return originUrl === '' ? undefined : originUrl;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) {
        return undefined;
      }
      throw error;
    }
  }

  async clone(
    repositoryUrl: string,
    destination: string,
    options: GitCommandOptions = {},
  ): Promise<void> {
    await runGit(['clone', repositoryUrl, destination], options);
  }

  async checkoutDetach(
    revision: string,
    options: GitCommandOptions = {},
  ): Promise<void> {
    await runGit(['checkout', '--detach', revision], options);
  }
}
