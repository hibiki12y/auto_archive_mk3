import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_ENVELOPE_SCHEMA_VERSION,
  createResourceEnvelope,
  createRuntimeSettingsBundle,
  projectCapabilityEnvelope,
} from '../../src/index.js';

describe('capability envelope projection', () => {
  it('projects runtime settings and resources into metadata-only capability envelope', () => {
    const runtimeSettings = createRuntimeSettingsBundle({
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: '.',
    });
    const resourceEnvelope = createResourceEnvelope({
      requested: { cpuCores: 4, memoryMiB: 1024, wallTimeSec: 600, gpuCards: 1 },
      effective: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 300, gpuCards: 0 },
    });

    const envelope = projectCapabilityEnvelope({ runtimeSettings, resourceEnvelope });

    expect(envelope).toEqual({
      schemaVersion: CAPABILITY_ENVELOPE_SCHEMA_VERSION,
      filesystemWriteScope: 'workspace-write',
      networkEgress: {
        class: 'provider-only',
        networkAccessEnabled: true,
        webSearchMode: 'provider',
      },
      toolGrant: {
        class: 'approval-required',
        approvalPolicy: 'on-request',
      },
      credentialReference: {
        class: 'none-declared',
        secretValuesRendered: false,
      },
      runtimeLimits: {
        cpuCores: 2,
        memoryMiB: 512,
        wallTimeSec: 300,
        gpuCards: 0,
      },
      provenance: {
        source: 'runtime-settings-and-resource-envelope',
        metadataOnly: true,
        enforcementChanged: false,
      },
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.networkEgress)).toBe(true);
    expect(Object.isFrozen(envelope.toolGrant)).toBe(true);
    expect(Object.isFrozen(envelope.credentialReference)).toBe(true);
    expect(Object.isFrozen(envelope.runtimeLimits)).toBe(true);
    expect(Object.isFrozen(envelope.provenance)).toBe(true);
  });

  it('distinguishes offline/no-approval dispatches without changing enforcement', () => {
    const runtimeSettings = createRuntimeSettingsBundle({
      networkProfile: 'offline',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    const resourceEnvelope = createResourceEnvelope({
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    });

    const envelope = projectCapabilityEnvelope({ runtimeSettings, resourceEnvelope });

    expect(envelope.filesystemWriteScope).toBe('read-only');
    expect(envelope.networkEgress).toMatchObject({
      class: 'offline',
      networkAccessEnabled: false,
      webSearchMode: 'off',
    });
    expect(envelope.toolGrant).toEqual({
      class: 'preapproved-runtime-tools',
      approvalPolicy: 'never',
    });
    expect(envelope.provenance).toMatchObject({
      metadataOnly: true,
      enforcementChanged: false,
    });
  });
});
