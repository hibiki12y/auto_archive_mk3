import type { ResourceEnvelope } from './resource-envelope.js';
import type { RuntimeSettingsBundle } from './runtime-settings.js';

export const CAPABILITY_ENVELOPE_SCHEMA_VERSION = 1;

export type FilesystemWriteScope =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type NetworkEgressClass =
  | 'offline'
  | 'provider-only'
  | 'restricted-egress'
  | 'open-egress';

export type ToolGrantClass = 'approval-required' | 'preapproved-runtime-tools';

export type CredentialReferenceClass = 'none-declared';

export interface CapabilityEnvelopeRuntimeLimits {
  readonly cpuCores: number;
  readonly memoryMiB: number;
  readonly wallTimeSec: number;
  readonly gpuCards: number;
}

export interface CapabilityEnvelope {
  readonly schemaVersion: typeof CAPABILITY_ENVELOPE_SCHEMA_VERSION;
  readonly filesystemWriteScope: FilesystemWriteScope;
  readonly networkEgress: {
    readonly class: NetworkEgressClass;
    readonly networkAccessEnabled: boolean;
    readonly webSearchMode: RuntimeSettingsBundle['networkProjection']['webSearchMode'];
  };
  readonly toolGrant: {
    readonly class: ToolGrantClass;
    readonly approvalPolicy: RuntimeSettingsBundle['approvalPolicy'];
  };
  /**
   * Metadata-only placeholder for this first slice. The projection does not
   * inspect credential stores or infer live secret availability; future
   * credential-reference support must bump the schema if semantics change.
   */
  readonly credentialReference: {
    readonly class: CredentialReferenceClass;
    readonly secretValuesRendered: false;
  };
  readonly runtimeLimits: CapabilityEnvelopeRuntimeLimits;
  readonly provenance: {
    readonly source: 'runtime-settings-and-resource-envelope';
    readonly metadataOnly: true;
    readonly enforcementChanged: false;
  };
}

export interface ProjectCapabilityEnvelopeInput {
  readonly runtimeSettings: RuntimeSettingsBundle;
  readonly resourceEnvelope: ResourceEnvelope;
}

export function projectCapabilityEnvelope(
  input: ProjectCapabilityEnvelopeInput,
): CapabilityEnvelope {
  return Object.freeze({
    schemaVersion: CAPABILITY_ENVELOPE_SCHEMA_VERSION,
    filesystemWriteScope: input.runtimeSettings.sandboxMode,
    networkEgress: Object.freeze({
      class: input.runtimeSettings.networkProfile,
      networkAccessEnabled:
        input.runtimeSettings.networkProjection.networkAccessEnabled,
      webSearchMode: input.runtimeSettings.networkProjection.webSearchMode,
    }),
    toolGrant: Object.freeze({
      class:
        input.runtimeSettings.approvalPolicy === 'on-request'
          ? 'approval-required'
          : 'preapproved-runtime-tools',
      approvalPolicy: input.runtimeSettings.approvalPolicy,
    }),
    credentialReference: Object.freeze({
      class: 'none-declared',
      secretValuesRendered: false,
    }),
    runtimeLimits: Object.freeze({
      cpuCores: input.resourceEnvelope.effective.cpuCores,
      memoryMiB: input.resourceEnvelope.effective.memoryMiB,
      wallTimeSec: input.resourceEnvelope.effective.wallTimeSec,
      gpuCards: input.resourceEnvelope.effective.gpuCards,
    }),
    provenance: Object.freeze({
      source: 'runtime-settings-and-resource-envelope',
      metadataOnly: true,
      enforcementChanged: false,
    }),
  });
}
