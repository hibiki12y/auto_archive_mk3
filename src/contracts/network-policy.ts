export type NetworkPolicyProfile =
  | 'offline'
  | 'provider-only'
  | 'restricted-egress'
  | 'open-egress';

export type WebSearchMode = 'off' | 'provider';

export interface RuntimeNetworkProjection {
  networkAccessEnabled: boolean;
  webSearchMode: WebSearchMode;
}

const NETWORK_POLICY_PROFILES = [
  'offline',
  'provider-only',
  'restricted-egress',
  'open-egress',
] as const satisfies readonly NetworkPolicyProfile[];

export function isNetworkPolicyProfile(
  value: unknown,
): value is NetworkPolicyProfile {
  return (
    typeof value === 'string' &&
    NETWORK_POLICY_PROFILES.includes(value as NetworkPolicyProfile)
  );
}

export function assertNetworkPolicyProfile(
  value: unknown,
): asserts value is NetworkPolicyProfile {
  if (!isNetworkPolicyProfile(value)) {
    throw new Error(
      `networkProfile must be one of: ${NETWORK_POLICY_PROFILES.join(', ')}`,
    );
  }
}

export function projectNetworkPolicyProfile(
  profile: NetworkPolicyProfile,
): RuntimeNetworkProjection {
  assertNetworkPolicyProfile(profile);

  switch (profile) {
    case 'offline':
      return Object.freeze({
        networkAccessEnabled: false,
        webSearchMode: 'off',
      });
    case 'provider-only':
      return Object.freeze({
        networkAccessEnabled: true,
        webSearchMode: 'provider',
      });
    case 'restricted-egress':
    case 'open-egress':
      return Object.freeze({
        networkAccessEnabled: true,
        webSearchMode: 'off',
      });
  }
}
