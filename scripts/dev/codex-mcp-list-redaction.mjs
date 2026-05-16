const secretishKeyPattern =
  /(?:api[_-]?key|token|secret|password|credential|authorization|bearer)/i;
const secretishTextKeyPattern =
  /(?:api[_-]?key|token|secret|password|credential)/i;

function redactUrlCredentials(value) {
  return value.replaceAll(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi,
    '$1[redacted]@',
  );
}

export function redactSecretishText(value) {
  const valuePattern = `("[^"]*"|'[^']*'|[^\\s,}\\]\\[]+)`;
  return redactUrlCredentials(value)
    .replaceAll(
      /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)([^\s"',}\]]+)/gi,
      '$1[redacted]',
    )
    .replaceAll(
      new RegExp(
        `(--?${secretishTextKeyPattern.source}(?:=|\\s+))${valuePattern}`,
        'gi',
      ),
      '$1[redacted]',
    )
    .replaceAll(
      new RegExp(
        `("?${secretishTextKeyPattern.source}[^":=\\s]*"?\\s*[:=]\\s*)${valuePattern}`,
        'gi',
      ),
      '$1[redacted]',
    );
}

function redactEnvObject(entry) {
  return Object.fromEntries(Object.keys(entry).map((envName) => [envName, '[redacted]']));
}

function redactEnvArray(entry) {
  return entry.map((item) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          key,
          key === 'name' && typeof value === 'string' ? value : '[redacted]',
        ]),
      );
    }

    return '[redacted]';
  });
}

export function sanitizeMcpListValue(value, parentKey = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMcpListValue(entry, parentKey));
  }

  if (value !== null && typeof value === 'object') {
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'env') {
        sanitized[key] =
          entry === null
            ? null
            : Array.isArray(entry)
              ? redactEnvArray(entry)
              : typeof entry === 'object'
                ? redactEnvObject(entry)
                : '[redacted]';
        continue;
      }

      if (secretishKeyPattern.test(key)) {
        sanitized[key] = typeof entry === 'string' ? '[redacted]' : entry;
        continue;
      }

      sanitized[key] = sanitizeMcpListValue(entry, key);
    }
    return sanitized;
  }

  if (typeof value === 'string') {
    if (parentKey === 'env' || secretishKeyPattern.test(parentKey)) {
      return '[redacted]';
    }
    return redactSecretishText(value);
  }

  return value;
}

export function sanitizeMcpListOutput(stdout) {
  try {
    return `${JSON.stringify(sanitizeMcpListValue(JSON.parse(stdout)), null, 2)}\n`;
  } catch {
    return redactSecretishText(stdout);
  }
}
