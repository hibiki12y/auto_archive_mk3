/**
 * M10 — ACP adapter public surface.
 *
 * Exports the server class, prompt bridge, permission bridge, slash-command
 * adapter, session store, and logger types that make up the staged M10 surface.
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
