import type { DiscordAuthDatabase } from './discord-auth-database.js';

export type DiscordAccessAction =
  | 'ask'
  | 'research'
  | 'evidence'
  | 'claim'
  | 'critique'
  | 'proof'
  | 'status'
  | 'cancel'
  | 'rerun'
  | 'archive'
  | 'unarchive'
  | 'tasks'
  | 'traits'
  | 'agenda'
  | 'history'
  | 'context'
  | 'escalate'
  | 'feed'
  | 'approve'
  | 'deny'
  | 'doctor'
  | 'subagents'
  | 'focus'
  | 'unfocus'
  | 'auth'
  | 'config'
  | 'help'
  | 'quickstart'
  | 'follow'
  | 'insights'
  | 'research-plan';

export interface DiscordAccessCheckInput {
  readonly action: DiscordAccessAction;
  readonly userId: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly authorIsBot?: boolean;
}

export type DiscordAccessDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'denied'; readonly reason: string };

export interface DiscordAccessPolicyOptions {
  readonly allowedGuildIds?: readonly string[];
  readonly allowedUserIds?: readonly string[];
  readonly allowedChannelIds?: readonly string[];
  readonly adminUserIds?: readonly string[];
  readonly authDatabase?: DiscordAuthDatabase;
  readonly allowDms?: boolean;
  readonly allowBots?: boolean;
}

const ADMIN_ACTIONS = new Set<DiscordAccessAction>([
  'approve',
  'deny',
  'doctor',
  'proof',
  'subagents',
  'auth',
  'config',
  'research-plan',
]);

function normalizeIds(ids: readonly string[] | undefined): Set<string> {
  return new Set((ids ?? []).map((id) => id.trim()).filter(Boolean));
}

export function parseDiscordIdList(rawValue: string | undefined): readonly string[] {
  if (rawValue === undefined || rawValue.trim() === '') {
    return [];
  }
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export class DiscordAccessPolicy {
  private readonly allowedGuildIds: Set<string>;
  private readonly allowedUserIds: Set<string>;
  private readonly allowedChannelIds: Set<string>;
  private readonly adminUserIds: Set<string>;
  private readonly authDatabase: DiscordAuthDatabase | undefined;
  private readonly allowDms: boolean;
  private readonly allowBots: boolean;

  constructor(options: DiscordAccessPolicyOptions = {}) {
    this.allowedGuildIds = normalizeIds(options.allowedGuildIds);
    this.allowedUserIds = normalizeIds(options.allowedUserIds);
    this.allowedChannelIds = normalizeIds(options.allowedChannelIds);
    this.adminUserIds = normalizeIds(options.adminUserIds);
    this.authDatabase = options.authDatabase;
    this.allowDms = options.allowDms ?? false;
    this.allowBots = options.allowBots ?? false;
  }

  check(input: DiscordAccessCheckInput): DiscordAccessDecision {
    if (input.authorIsBot === true && !this.allowBots) {
      return { status: 'denied', reason: 'bot-authors-disabled' };
    }

    if (!this.allowDms && input.guildId === undefined) {
      return { status: 'denied', reason: 'dm-disabled' };
    }

    if (
      this.hasAllowedGuildRestriction() &&
      (input.guildId === undefined || !this.isGuildAllowed(input.guildId))
    ) {
      return { status: 'denied', reason: 'guild-not-allowed' };
    }

    if (
      this.hasAllowedChannelRestriction() &&
      (input.channelId === undefined || !this.isChannelAllowed(input.channelId))
    ) {
      return { status: 'denied', reason: 'channel-not-allowed' };
    }

    const isAdmin = this.isAdminUser(input.userId);
    if (ADMIN_ACTIONS.has(input.action) && !isAdmin) {
      return { status: 'denied', reason: 'admin-required' };
    }

    if (
      this.hasAllowedUserRestriction() &&
      !this.isUserAllowed(input.userId) &&
      !isAdmin
    ) {
      return { status: 'denied', reason: 'user-not-allowed' };
    }

    return { status: 'allowed' };
  }

  describe(): Record<string, unknown> {
    const databaseCounts = this.authDatabase?.describe();
    return {
      allowedGuildCount:
        this.allowedGuildIds.size + (databaseCounts?.allowedGuildCount ?? 0),
      allowedUserCount:
        this.allowedUserIds.size + (databaseCounts?.allowedUserCount ?? 0),
      allowedChannelCount:
        this.allowedChannelIds.size + (databaseCounts?.allowedChannelCount ?? 0),
      adminUserCount:
        this.adminUserIds.size + (databaseCounts?.adminUserCount ?? 0),
      databaseBacked: this.authDatabase !== undefined,
      allowDms: this.allowDms,
      allowBots: this.allowBots,
    };
  }

  private hasAllowedGuildRestriction(): boolean {
    return (
      this.allowedGuildIds.size > 0 ||
      this.authDatabase?.hasAllowedGuilds() === true
    );
  }

  private isGuildAllowed(guildId: string): boolean {
    return (
      this.allowedGuildIds.has(guildId) ||
      this.authDatabase?.isGuildAllowed(guildId) === true
    );
  }

  private hasAllowedUserRestriction(): boolean {
    return (
      this.allowedUserIds.size > 0 ||
      this.authDatabase?.hasAllowedUsers() === true
    );
  }

  private isUserAllowed(userId: string): boolean {
    return (
      this.allowedUserIds.has(userId) ||
      this.authDatabase?.isUserAllowed(userId) === true
    );
  }

  private hasAllowedChannelRestriction(): boolean {
    return (
      this.allowedChannelIds.size > 0 ||
      this.authDatabase?.hasAllowedChannels() === true
    );
  }

  private isChannelAllowed(channelId: string): boolean {
    return (
      this.allowedChannelIds.has(channelId) ||
      this.authDatabase?.isChannelAllowed(channelId) === true
    );
  }

  isAdminUser(userId: string): boolean {
    return (
      this.adminUserIds.has(userId) ||
      this.authDatabase?.isAdminUser(userId) === true
    );
  }
}
