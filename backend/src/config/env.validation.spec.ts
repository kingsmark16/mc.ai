import { validateEnvironment } from './env.validation.js';

const validEnvironment = {
  GOOGLE_API_KEY: 'google-key',
  ASTRA_DB_API_ENDPOINT: 'https://example.apps.astra.datastax.com',
  ASTRA_DB_APPLICATION_TOKEN: 'astra-token',
  ASTRA_DB_KEYSPACE: 'default_keyspace',
  ASTRA_DB_COLLECTION: 'rag_documents',
};

describe('validateEnvironment', () => {
  it('applies safe defaults for optional settings', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      PORT: 3005,
      COOKIE_SAME_SITE: 'lax',
      GOOGLE_MODEL: 'gemini-3.1-flash-lite',
      GOOGLE_EMBEDDING_MODEL: 'gemini-embedding-001',
    });
  });

  it('keeps explicitly configured model settings', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        PORT: '4100',
        GOOGLE_MODEL: 'custom-chat-model',
        GOOGLE_EMBEDDING_MODEL: 'custom-embedding-model',
      }),
    ).toMatchObject({
      PORT: 4100,
      GOOGLE_MODEL: 'custom-chat-model',
      GOOGLE_EMBEDDING_MODEL: 'custom-embedding-model',
    });
  });

  it('reports missing required variables', () => {
    expect(() => validateEnvironment({})).toThrow('GOOGLE_API_KEY is required');
  });

  it('rejects an insecure Astra endpoint and invalid port', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ASTRA_DB_API_ENDPOINT: 'http://example.com',
        PORT: '70000',
      }),
    ).toThrow(
      'ASTRA_DB_API_ENDPOINT must use HTTPS\n- PORT must be an integer between 1 and 65535',
    );
  });

  it('requires explicit HTTPS CORS origins in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
      }),
    ).toThrow('CORS_ORIGINS is required in production');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://localhost:5173',
      }),
    ).toThrow('CORS_ORIGINS must contain HTTPS origins');
  });

  it('uses cross-site cookies for separate HTTPS deployments', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://mc-ai.vercel.app',
      }),
    ).toMatchObject({ COOKIE_SAME_SITE: 'none' });

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow('COOKIE_SAME_SITE=none requires NODE_ENV=production');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        COOKIE_SAME_SITE: 'strict',
      }),
    ).toThrow('COOKIE_SAME_SITE must be either lax or none');
  });
});
