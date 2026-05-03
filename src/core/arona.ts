import type { LifecycleObserver } from '../contracts/dispatch-lifecycle.js';
import type { DispatchSubmission } from '../contracts/dispatch-submission.js';
import type { VetoPath } from '../contracts/veto.js';
import type { Dispatcher } from './dispatcher.js';
import type {
  GitLabCreateIssueInput,
  GitLabCreateIssueNoteInput,
  GitLabCreateProjectInput,
  GitLabEnsureProjectInput,
  GitLabInstanceManager,
  GitLabIssueNoteReference,
  GitLabIssueReference,
  GitLabManagedProjectReference,
  GitLabProjectAssignment,
  GitLabProjectAssignmentManager,
  GitLabProjectManager,
  GitLabWorkResultRecorder,
  GitLabWorkResultRecording,
} from './gitlab-project-manager.js';
import type { Plana } from './plana.js';
import {
  attachGitLabProjectAssignment,
  createDispatchPlan,
  type DispatchPlan,
  type TaskRequest,
} from './task.js';

export type AronaDispatchResult =
  | {
      kind: 'vetoed';
      plan: DispatchPlan;
      veto: VetoPath;
    }
  | {
      kind: 'dispatched';
      plan: DispatchPlan;
      submission: DispatchSubmission;
      gitLabAssignment?: GitLabProjectAssignment;
      gitLabRecording?: Promise<GitLabWorkResultRecording>;
    };

export interface AronaRequestDispatchOptions {
  lifecycleObserver?: LifecycleObserver;
}

export interface AronaOptions {
  readonly gitLabProjectManager?: GitLabProjectManager;
  readonly gitLabInstanceManager?: GitLabInstanceManager;
  readonly gitLabProjectAssignmentManager?: GitLabProjectAssignmentManager;
  readonly gitLabWorkResultRecorder?: GitLabWorkResultRecorder;
  /**
   * F12: invoked when the GitLab work-result recording promise rejects.
   * Without this callback, an unobserved rejection would surface as a
   * Node `unhandledRejection` (process termination on Node ≥15). Arona
   * always attaches a tee'd `.catch` to consume the rejection signal;
   * the original `gitLabRecording` promise is still surfaced unchanged
   * on `AronaDispatchResult` so awaiting consumers continue to see the
   * rejection if they choose to observe it.
   */
  readonly onGitLabRecordingError?: (
    error: unknown,
    plan: DispatchPlan,
  ) => void;
}

export class Arona {
  constructor(
    private readonly plana: Plana,
    private readonly dispatcher: Dispatcher,
    private readonly options: AronaOptions = {},
  ) {}

  preparePlan(request: TaskRequest): DispatchPlan {
    return createDispatchPlan(request);
  }

  async requestDispatch(
    request: TaskRequest,
    options?: AronaRequestDispatchOptions,
  ): Promise<AronaDispatchResult> {
    let plan = this.preparePlan(request);
    const review = this.plana.reviewPreDispatch(plan);

    if (review.status === 'vetoed') {
      return {
        kind: 'vetoed',
        plan,
        veto: review.veto,
      };
    }

    const gitLabAssignment =
      await this.options.gitLabProjectAssignmentManager?.assignProjectForTask(
        plan,
      );
    if (gitLabAssignment !== undefined) {
      plan = attachGitLabProjectAssignment(plan, gitLabAssignment);
    }

    const submission = this.dispatcher.submit(plan, this.plana, {
      lifecycleObserver: options?.lifecycleObserver,
    });
    const gitLabRecording =
      this.options.gitLabWorkResultRecorder?.recordCompletion(
        plan,
        submission.completion,
        gitLabAssignment,
      );
    if (gitLabRecording !== undefined) {
      // F12: tee'd handler consumes the unhandled-rejection signal so a
      // GitLab outage cannot terminate the Node process. The original
      // `gitLabRecording` returned to the caller stays observable.
      const errorHandler = this.options.onGitLabRecordingError;
      const recordingPlan = plan;
      gitLabRecording.then(
        () => undefined,
        (error: unknown) => {
          errorHandler?.(error, recordingPlan);
        },
      );
    }

    return {
      kind: 'dispatched',
      plan,
      submission,
      ...(gitLabAssignment === undefined ? {} : { gitLabAssignment }),
      ...(gitLabRecording === undefined ? {} : { gitLabRecording }),
    };
  }

  async getGitLabProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference> {
    return this.requireGitLabInstanceManager().getProject(projectId);
  }

  async createGitLabProject(
    input: GitLabCreateProjectInput,
  ): Promise<GitLabManagedProjectReference> {
    return this.requireGitLabInstanceManager().createProject(input);
  }

  async ensureGitLabProject(
    input: GitLabEnsureProjectInput,
  ): Promise<GitLabManagedProjectReference> {
    return this.requireGitLabInstanceManager().ensureProject(input);
  }

  async listGitLabTaskProjects(input: {
    readonly search?: string;
    readonly membership?: boolean;
  } = {}): Promise<readonly GitLabManagedProjectReference[]> {
    const manager = this.requireGitLabInstanceManager();
    if (manager.listProjects === undefined) {
      throw new Error('GitLab project listing is not supported by the configured manager.');
    }
    return manager.listProjects(input);
  }

  async inspectGitLabTaskProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference> {
    return this.getGitLabProject(projectId);
  }

  async archiveGitLabTaskProject(
    projectId: string | number,
  ): Promise<GitLabManagedProjectReference> {
    const manager = this.requireGitLabInstanceManager();
    if (manager.archiveProject === undefined) {
      throw new Error('GitLab project archive is not supported by the configured manager.');
    }
    return manager.archiveProject(projectId);
  }

  async addGitLabFollowUpNote(input: {
    readonly projectId: string | number;
    readonly issueIid: number;
    readonly body: string;
    readonly internal?: boolean;
  }): Promise<GitLabIssueNoteReference> {
    return this.requireGitLabInstanceManager().createIssueNoteInProject(
      input.projectId,
      {
        issueIid: input.issueIid,
        body: input.body,
        internal: input.internal,
      },
    );
  }

  async createGitLabIssue(
    input: GitLabCreateIssueInput,
  ): Promise<GitLabIssueReference> {
    return this.requireGitLabProjectManager().createIssue(input);
  }

  async addGitLabIssueNote(
    input: GitLabCreateIssueNoteInput,
  ): Promise<GitLabIssueNoteReference> {
    return this.requireGitLabProjectManager().createIssueNote(input);
  }

  async closeGitLabIssue(issueIid: number): Promise<GitLabIssueReference> {
    return this.requireGitLabProjectManager().closeIssue(issueIid);
  }

  private requireGitLabProjectManager(): GitLabProjectManager {
    if (this.options.gitLabProjectManager === undefined) {
      throw new Error('GitLab project manager is not configured for Arona.');
    }
    return this.options.gitLabProjectManager;
  }

  private requireGitLabInstanceManager(): GitLabInstanceManager {
    if (this.options.gitLabInstanceManager === undefined) {
      throw new Error('GitLab instance manager is not configured for Arona.');
    }
    return this.options.gitLabInstanceManager;
  }
}
