export interface ResourceSpecInput {
  cpuCores: number;
  memoryMiB: number;
  wallTimeSec: number;
  gpuCards?: number;
}

export interface ResourceSpec {
  cpuCores: number;
  memoryMiB: number;
  wallTimeSec: number;
  gpuCards: number;
}

export interface ObservedResourceSummary {
  cpuCoresPeak?: number;
  memoryMiBPeak?: number;
  wallTimeSec?: number;
  gpuCardsPeak?: number;
  notes?: string;
}

export interface ResourceEnvelope {
  requested: ResourceSpec;
  effective: ResourceSpec;
  observed?: ObservedResourceSummary;
}

export interface ResourceEnvelopeInput {
  requested: ResourceSpecInput;
  effective?: Partial<ResourceSpecInput>;
  observed?: ObservedResourceSummary;
}

export interface PlanningResourceEnvelopeInput {
  requested: ResourceSpecInput;
  effective?: Partial<ResourceSpecInput>;
}

function normalizeInteger(
  fieldName: keyof ResourceSpec,
  value: number,
  minimum: number,
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${fieldName} must be an integer greater than or equal to ${minimum}`,
    );
  }

  return value;
}

export function normalizeResourceSpec(input: ResourceSpecInput): ResourceSpec {
  return {
    cpuCores: normalizeInteger('cpuCores', input.cpuCores, 1),
    memoryMiB: normalizeInteger('memoryMiB', input.memoryMiB, 1),
    wallTimeSec: normalizeInteger('wallTimeSec', input.wallTimeSec, 1),
    gpuCards: normalizeInteger('gpuCards', input.gpuCards ?? 0, 0),
  };
}

function mergeEffectiveSpec(
  requested: ResourceSpec,
  effective?: Partial<ResourceSpecInput>,
): ResourceSpec {
  if (!effective) {
    return { ...requested };
  }

  return normalizeResourceSpec({
    cpuCores: effective.cpuCores ?? requested.cpuCores,
    memoryMiB: effective.memoryMiB ?? requested.memoryMiB,
    wallTimeSec: effective.wallTimeSec ?? requested.wallTimeSec,
    gpuCards: effective.gpuCards ?? requested.gpuCards,
  });
}

export function validateEffectiveWithinRequested(
  requested: ResourceSpec,
  effective: ResourceSpec,
): void {
  const checks: Array<keyof ResourceSpec> = [
    'cpuCores',
    'memoryMiB',
    'wallTimeSec',
    'gpuCards',
  ];

  for (const fieldName of checks) {
    if (effective[fieldName] > requested[fieldName]) {
      throw new Error(
        `effective ${fieldName} must not exceed requested ${fieldName}`,
      );
    }
  }
}

export function createResourceEnvelope(
  input: ResourceEnvelopeInput,
): ResourceEnvelope {
  const requested = normalizeResourceSpec(input.requested);
  const effective = mergeEffectiveSpec(requested, input.effective);

  validateEffectiveWithinRequested(requested, effective);

  const observed =
    input.observed !== undefined
      ? assertObservedResourceSummary(input.observed)
      : undefined;

  return {
    requested,
    effective,
    observed,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function requireIntegerField(
  scope: string,
  record: Record<string, unknown>,
  fieldName: string,
  minimum: number,
): number {
  const raw = record[fieldName];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum) {
    throw new TypeError(
      `${scope}.${fieldName} must be an integer >= ${minimum}`,
    );
  }
  return raw;
}

function requireOptionalIntegerField(
  scope: string,
  record: Record<string, unknown>,
  fieldName: string,
  minimum: number,
): number | undefined {
  const raw = record[fieldName];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum) {
    throw new TypeError(
      `${scope}.${fieldName} must be an integer >= ${minimum} when present`,
    );
  }
  return raw;
}

export function assertResourceSpec(v: unknown): ResourceSpec {
  if (!isPlainObject(v)) {
    throw new TypeError('ResourceSpec must be a plain object');
  }
  return {
    cpuCores: requireIntegerField('ResourceSpec', v, 'cpuCores', 1),
    memoryMiB: requireIntegerField('ResourceSpec', v, 'memoryMiB', 1),
    wallTimeSec: requireIntegerField('ResourceSpec', v, 'wallTimeSec', 1),
    gpuCards: requireIntegerField('ResourceSpec', v, 'gpuCards', 0),
  };
}

export function assertObservedResourceSummary(
  v: unknown,
): ObservedResourceSummary {
  if (!isPlainObject(v)) {
    throw new TypeError('ObservedResourceSummary must be a plain object');
  }
  const result: ObservedResourceSummary = {};
  const cpuCoresPeak = requireOptionalIntegerField(
    'ObservedResourceSummary',
    v,
    'cpuCoresPeak',
    0,
  );
  if (cpuCoresPeak !== undefined) result.cpuCoresPeak = cpuCoresPeak;
  const memoryMiBPeak = requireOptionalIntegerField(
    'ObservedResourceSummary',
    v,
    'memoryMiBPeak',
    0,
  );
  if (memoryMiBPeak !== undefined) result.memoryMiBPeak = memoryMiBPeak;
  const wallTimeSec = requireOptionalIntegerField(
    'ObservedResourceSummary',
    v,
    'wallTimeSec',
    0,
  );
  if (wallTimeSec !== undefined) result.wallTimeSec = wallTimeSec;
  const gpuCardsPeak = requireOptionalIntegerField(
    'ObservedResourceSummary',
    v,
    'gpuCardsPeak',
    0,
  );
  if (gpuCardsPeak !== undefined) result.gpuCardsPeak = gpuCardsPeak;
  if (v.notes !== undefined) {
    if (typeof v.notes !== 'string') {
      throw new TypeError(
        'ObservedResourceSummary.notes must be a string when present',
      );
    }
    result.notes = v.notes;
  }
  return result;
}

export function assertResourceEnvelope(v: unknown): ResourceEnvelope {
  if (!isPlainObject(v)) {
    throw new TypeError('ResourceEnvelope must be a plain object');
  }
  if (!('requested' in v)) {
    throw new TypeError('ResourceEnvelope.requested is required');
  }
  if (!('effective' in v)) {
    throw new TypeError('ResourceEnvelope.effective is required');
  }
  let requested: ResourceSpec;
  let effective: ResourceSpec;
  try {
    requested = assertResourceSpec(v.requested);
  } catch (err) {
    throw new TypeError(
      `ResourceEnvelope.requested invalid: ${(err as Error).message}`,
    );
  }
  try {
    effective = assertResourceSpec(v.effective);
  } catch (err) {
    throw new TypeError(
      `ResourceEnvelope.effective invalid: ${(err as Error).message}`,
    );
  }
  try {
    validateEffectiveWithinRequested(requested, effective);
  } catch (err) {
    throw new TypeError((err as Error).message);
  }
  const envelope: ResourceEnvelope = { requested, effective };
  if (v.observed !== undefined) {
    envelope.observed = assertObservedResourceSummary(v.observed);
  }
  return envelope;
}

export function freezeResourceEnvelope(
  e: ResourceEnvelope,
): Readonly<ResourceEnvelope> {
  return Object.freeze({
    requested: Object.freeze({ ...e.requested }),
    effective: Object.freeze({ ...e.effective }),
    observed: e.observed ? Object.freeze({ ...e.observed }) : undefined,
  }) as Readonly<ResourceEnvelope>;
}

export function createPlannedResourceEnvelope(
  input: PlanningResourceEnvelopeInput,
): ResourceEnvelope {
  if (Object.prototype.hasOwnProperty.call(input, 'observed')) {
    throw new Error(
      'observed resource usage is runtime evidence and cannot be supplied for dispatch planning',
    );
  }

  return createResourceEnvelope({
    requested: input.requested,
    effective: input.effective,
  });
}
