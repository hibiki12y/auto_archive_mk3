export type VetoOrigin = 'pre-dispatch' | 'runtime';

export interface VetoPropagation {
  blocksSubmission: boolean;
  requestsCancellation: boolean;
  requestsTermination: boolean;
}

export interface VetoPath {
  origin: VetoOrigin;
  reason: string;
  provenance: string;
  propagation: VetoPropagation;
}

export function createVetoPath(
  origin: VetoOrigin,
  reason: string,
  provenance: string,
): VetoPath {
  if (origin === 'pre-dispatch') {
    return {
      origin,
      reason,
      provenance,
      propagation: {
        blocksSubmission: true,
        requestsCancellation: false,
        requestsTermination: false,
      },
    };
  }

  return {
    origin,
    reason,
    provenance,
    propagation: {
      blocksSubmission: false,
      requestsCancellation: true,
      requestsTermination: true,
    },
  };
}
