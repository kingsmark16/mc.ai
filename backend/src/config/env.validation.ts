const requiredEnvironmentKeys = [
  'GOOGLE_API_KEY',
  'ASTRA_DB_API_ENDPOINT',
  'ASTRA_DB_APPLICATION_TOKEN',
  'ASTRA_DB_KEYSPACE',
  'ASTRA_DB_COLLECTION',
] as const;

export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const configuredEnvironment =
    typeof config.NODE_ENV === 'string'
      ? config.NODE_ENV.trim().toLowerCase()
      : 'development';
  const environment = configuredEnvironment === 'prod'
    ? 'production'
    : configuredEnvironment;
  const configuredCookieSameSite =
    typeof config.COOKIE_SAME_SITE === 'string' &&
    config.COOKIE_SAME_SITE.trim()
      ? config.COOKIE_SAME_SITE.trim().toLowerCase()
      : environment === 'production'
        ? 'none'
        : 'lax';

  for (const key of requiredEnvironmentKeys) {
    const value = config[key];

    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${key} is required`);
    }
  }

  const endpoint = config.ASTRA_DB_API_ENDPOINT;

  if (typeof endpoint === 'string' && endpoint.trim()) {
    try {
      const url = new URL(endpoint);

      if (url.protocol !== 'https:') {
        errors.push('ASTRA_DB_API_ENDPOINT must use HTTPS');
      }
    } catch {
      errors.push('ASTRA_DB_API_ENDPOINT must be a valid URL');
    }
  }

  const port = config.PORT ?? '3005';
  const parsedPort = Number(port);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  if (environment === 'production') {
    const configuredCorsOrigins = config.CORS_ORIGINS;

    if (
      typeof configuredCorsOrigins !== 'string' ||
      !configuredCorsOrigins.trim()
    ) {
      errors.push('CORS_ORIGINS is required in production');
    } else {
      for (const origin of configuredCorsOrigins
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        try {
          const url = new URL(origin);

          if (
            url.protocol !== 'https:' ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
          ) {
            errors.push(
              `CORS_ORIGINS must contain HTTPS origins without paths: ${origin}`,
            );
          }
        } catch {
          errors.push(`CORS_ORIGINS contains an invalid origin: ${origin}`);
        }
      }
    }
  }

  if (!['lax', 'none'].includes(configuredCookieSameSite)) {
    errors.push('COOKIE_SAME_SITE must be either lax or none');
  } else if (
    configuredCookieSameSite === 'none' &&
    environment !== 'production'
  ) {
    errors.push('COOKIE_SAME_SITE=none requires NODE_ENV=production');
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return {
    ...config,
    NODE_ENV: environment,
    PORT: parsedPort,
    COOKIE_SAME_SITE: configuredCookieSameSite,
    GOOGLE_MODEL:
      typeof config.GOOGLE_MODEL === 'string' && config.GOOGLE_MODEL.trim()
        ? config.GOOGLE_MODEL.trim()
        : 'gemini-3.1-flash-lite',
    GOOGLE_EMBEDDING_MODEL:
      typeof config.GOOGLE_EMBEDDING_MODEL === 'string' &&
      config.GOOGLE_EMBEDDING_MODEL.trim()
        ? config.GOOGLE_EMBEDDING_MODEL.trim()
        : 'gemini-embedding-001',
  };
}
