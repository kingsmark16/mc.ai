import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const configuredCorsOrigins = (
    configService.get<string>('CORS_ORIGINS') ??
    'http://localhost:5173,http://localhost:5174'
  )
    .split(',')
    .map((origin) => origin.trim())
    .map((origin) => origin.replace(/\/$/, ''))
    .filter(Boolean);
  const corsOrigins = [
    ...new Set([
      ...configuredCorsOrigins,
      ...(configService.get<string>('NODE_ENV') === 'production'
        ? []
        : [
            'http://localhost:5173',
            'http://localhost:5174',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:5174',
          ]),
    ]),
  ];
  const isDevelopment = configService.get<string>('NODE_ENV') !== 'production';

  const isLocalDevelopmentOrigin = (origin: string): boolean => {
    try {
      const url = new URL(origin);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const isLocalHost =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.local') ||
        /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname) ||
        /^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}$/.test(hostname);

      return url.protocol === 'http:' && isLocalHost;
    } catch {
      return false;
    }
  };

  const allowCorsOrigin = (
    origin: string | undefined,
    callback: (
      error: Error | null,
      allowedOrigin?: boolean | string | RegExp | (string | RegExp)[],
    ) => void,
  ) => {
    if (
      !origin ||
      corsOrigins.includes(origin) ||
      (isDevelopment && isLocalDevelopmentOrigin(origin))
    ) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin is not allowed by CORS'));
  };

  app.enableCors({
    allowedHeaders: ['Accept', 'Content-Type', 'X-CSRF-Token'],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    origin: allowCorsOrigin,
  });
  app.enableShutdownHooks();
  await app.listen(configService.get<number>('PORT') ?? 3005);
}
await bootstrap();
