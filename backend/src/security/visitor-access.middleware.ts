import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const visitorCookieName = 'rag_visitor';
export const csrfCookieName = 'rag_csrf';

const visitorCookieMaxAgeMs = 30 * 24 * 60 * 60 * 1_000;
const visitorIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const csrfTokenPattern = /^[0-9a-f]{64}$/;

export type VisitorRequest = Request & {
  visitorId: string;
  csrfToken: string;
};

@Injectable()
export class VisitorAccessMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const visitorCookie = this.readCookie(request, visitorCookieName);
    const visitorId = this.isValidVisitorId(visitorCookie)
      ? visitorCookie
      : randomUUID();

    const csrfCookie = this.readCookie(request, csrfCookieName);
    const csrfToken = this.isValidCsrfToken(csrfCookie)
      ? csrfCookie
      : randomBytes(32).toString('hex');

    if (visitorId !== visitorCookie) {
      response.cookie(visitorCookieName, visitorId, this.cookieOptions(true));
    }

    if (csrfToken !== csrfCookie) {
      response.cookie(csrfCookieName, csrfToken, this.cookieOptions(true));
    }

    const visitorRequest = request as VisitorRequest;
    visitorRequest.visitorId = visitorId;
    visitorRequest.csrfToken = csrfToken;

    if (this.requiresCsrf(request.method)) {
      const providedToken = request.get('x-csrf-token');

      if (!this.tokensMatch(csrfToken, providedToken)) {
        throw new ForbiddenException('Invalid CSRF token');
      }
    }

    next();
  }

  private requiresCsrf(method: string): boolean {
    return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  }

  private tokensMatch(expected: string, provided?: string): boolean {
    if (!provided || !this.isValidCsrfToken(provided)) {
      return false;
    }

    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided, 'utf8');

    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    );
  }

  private isValidVisitorId(value: string | undefined): value is string {
    return value !== undefined && visitorIdPattern.test(value);
  }

  private isValidCsrfToken(value: string | undefined): value is string {
    return value !== undefined && csrfTokenPattern.test(value);
  }

  private readCookie(request: Request, name: string): string | undefined {
    const header = request.headers.cookie;

    if (!header) {
      return undefined;
    }

    for (const part of header.split(';')) {
      const separator = part.indexOf('=');

      if (separator <= 0 || part.slice(0, separator).trim() !== name) {
        continue;
      }

      const rawValue = part.slice(separator + 1).trim();

      try {
        return decodeURIComponent(rawValue);
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private cookieOptions(httpOnly: boolean) {
    const sameSite =
      this.configService.get<string>('COOKIE_SAME_SITE') === 'none'
        ? ('none' as const)
        : ('lax' as const);

    return {
      httpOnly,
      maxAge: visitorCookieMaxAgeMs,
      path: '/',
      sameSite,
      secure: this.configService.get<string>('NODE_ENV') === 'production',
    };
  }
}
