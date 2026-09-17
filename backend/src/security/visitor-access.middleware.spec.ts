import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  VisitorAccessMiddleware,
  type VisitorRequest,
} from './visitor-access.middleware.js';

describe('VisitorAccessMiddleware', () => {
  const configService = {
    get: vi.fn().mockReturnValue('development'),
  } as unknown as ConfigService;

  function createResponse() {
    return {
      cookie: vi.fn(),
    } as unknown as Response;
  }

  it('creates a visitor identity and CSRF token when cookies are absent', () => {
    const request = {
      headers: {},
      method: 'GET',
    } as Request;
    const response = createResponse();
    const next = vi.fn();

    new VisitorAccessMiddleware(configService).use(request, response, next);

    const visitorRequest = request as VisitorRequest;

    expect(visitorRequest.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(visitorRequest.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(response.cookie).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets secure cross-site cookies in production', () => {
    const productionConfigService = {
      get: vi.fn((key: string) =>
        key === 'NODE_ENV' ? 'production' : 'none',
      ),
    } as unknown as ConfigService;
    const response = createResponse();

    new VisitorAccessMiddleware(productionConfigService).use(
      { headers: {}, method: 'GET' } as Request,
      response,
      vi.fn(),
    );

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      'rag_visitor',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'none', secure: true }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      'rag_csrf',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'none', secure: true }),
    );
  });

  it('reuses valid cookies without issuing a new identity', () => {
    const visitorId = '11111111-1111-4111-8111-111111111111';
    const csrfToken = 'a'.repeat(64);
    const request = {
      headers: {
        cookie: `rag_visitor=${visitorId}; rag_csrf=${csrfToken}`,
      },
      method: 'GET',
    } as Request;
    const response = createResponse();
    const next = vi.fn();

    new VisitorAccessMiddleware(configService).use(request, response, next);

    expect((request as VisitorRequest).visitorId).toBe(visitorId);
    expect((request as VisitorRequest).csrfToken).toBe(csrfToken);
    expect(response.cookie).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects state-changing requests without the matching CSRF header', () => {
    const csrfToken = 'b'.repeat(64);
    const request = {
      get: vi.fn().mockReturnValue(undefined),
      headers: {
        cookie: `rag_visitor=11111111-1111-4111-8111-111111111111; rag_csrf=${csrfToken}`,
      },
      method: 'POST',
    } as unknown as Request;

    expect(() =>
      new VisitorAccessMiddleware(configService).use(
        request,
        createResponse(),
        vi.fn(),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows state-changing requests with the matching CSRF header', () => {
    const csrfToken = 'c'.repeat(64);
    const request = {
      get: vi.fn().mockReturnValue(csrfToken),
      headers: {
        cookie: `rag_visitor=11111111-1111-4111-8111-111111111111; rag_csrf=${csrfToken}`,
      },
      method: 'POST',
    } as unknown as Request;
    const next = vi.fn();

    new VisitorAccessMiddleware(configService).use(
      request,
      createResponse(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });
});
