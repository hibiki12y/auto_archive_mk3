/**
 * M10 — ACP adapter public surface.
 *
 * Stage 1 exports the server class and types. Stage 2+ adds the
 * prompt bridge, permission bridge, slash-command adapter, and
 * session-store types as they land.
 */

export {
  AcpServer,
  type AcpLifecycleObserver,
  type AcpServerOptions,
  type AcpServerTraitHookBinding,
  type AcpSessionRotationEvent,
} from './acp-server.js';
export {
  JsonAcpSessionStore,
  type AcpSessionStore,
  type JsonAcpSessionStoreOptions,
  type PersistedAcpSessionRecord,
  defaultAcpSessionDirectory,
} from './acp-session-store.js';
export {
  AcpPromptBridge,
  type AcpPromptBridgeOptions,
  type AcpPromptDriver,
  type AcpPromptDriverInput,
  type AcpPromptStreamEvent,
} from './acp-prompt-bridge.js';
export {
  AcpPermissionBridge,
  type AcpPermissionBridgeOptions,
  DEFAULT_PERMISSION_OPTIONS,
} from './acp-permission-bridge.js';
export {
  buildAvailableCommands,
  commandDefToAvailable,
  notifyAvailableCommands,
} from './acp-slash-commands.js';
export {
  type AcpLogEvent,
  type AcpLogLevel,
  type AcpLogger,
  defaultAcpLogger,
  withScope,
} from './acp-logger.js';
