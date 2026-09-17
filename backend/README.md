# MC.AI backend

The backend is a NestJS API for MC.AI. It extracts PDF, DOCX, and TXT files,
creates searchable embeddings with Google Gemini, stores document chunks in
Astra DB, and streams grounded answers back to the frontend.

## Requirements

- Node.js 22 or newer
- A Google AI Studio project and API key with access to the configured chat and
  embedding models
- A paid Gemini API tier for production workloads that exceed free embedding
  quotas
- An Astra DB serverless database with a vector collection

## Configure the environment

Copy `.env.example` to `.env` and replace every placeholder:

```powershell
Copy-Item .env.example .env
```

Important settings:

| Variable | Purpose |
| --- | --- |
| `PORT` | API port. Defaults to `3005`. |
| `NODE_ENV` | Use `production` for a deployed API. |
| `CORS_ORIGINS` | Comma-separated frontend origins. Production requires HTTPS origins. |
| `COOKIE_SAME_SITE` | Use `none` for separate HTTPS Vercel/Azure origins; otherwise use `lax`. |
| `GOOGLE_API_KEY` | Google Gemini API key. Keep it server-side. |
| `GOOGLE_MODEL` | Gemini chat model. |
| `GOOGLE_EMBEDDING_MODEL` | Gemini embedding model. |
| `ASTRA_DB_API_ENDPOINT` | Astra DB HTTPS endpoint. |
| `ASTRA_DB_APPLICATION_TOKEN` | Astra DB application token. |
| `ASTRA_DB_KEYSPACE` | Astra DB keyspace. |
| `ASTRA_DB_COLLECTION` | Vector collection containing the document chunks. |
| `ENABLE_DIAGNOSTIC_ENDPOINTS` | Keep `false` in production. |

For production, use settings similar to:

```dotenv
NODE_ENV=production
CORS_ORIGINS=https://app.example.com
COOKIE_SAME_SITE=none
ENABLE_DIAGNOSTIC_ENDPOINTS=false
```

The API validates required credentials and the Astra HTTPS endpoint before it
starts. `COOKIE_SAME_SITE=none` is required when the frontend and API are on
different sites; it is paired with secure cookies and the existing CSRF token
checks. Never commit `.env` or expose `GOOGLE_API_KEY` in the frontend build.

## Run the API

```powershell
# Install exactly from the lockfile
npm ci

# Development
npm run start:dev

# Production build and process
npm run build
npm run start:prod
```

Run the production process under a supervisor such as systemd, a container
platform, or a process manager. Termination hooks are enabled so the server
can finish its shutdown lifecycle cleanly.

## Azure deployment

The included `Dockerfile` builds a production image with Node.js 20, compiles
the NestJS API, removes development dependencies, and starts `dist/main.js`.
It is suitable for Azure Web App for Containers or Azure Container Apps.

```powershell
docker build -t mc-ai-api:production .
docker run --env-file .env -p 3005:3005 mc-ai-api:production
```

In Azure, set the container ingress/port to `3005` and add the variables from
`.env.example` as application settings or Key Vault-backed secrets. Set
`NODE_ENV=production` and use the exact HTTPS Vercel URL for `CORS_ORIGINS`.
Set `ENABLE_DIAGNOSTIC_ENDPOINTS=false`.

If using Azure App Service's built-in Node runtime instead of the Dockerfile,
run `npm ci`, `npm run build`, and use `npm run start:prod` as the startup
command. The service still needs the same environment settings and port.

## API surface

- `GET /health` checks API availability and Astra connectivity.
- `GET /session` returns the browser session CSRF token.
- `POST /documents/file` indexes one PDF, DOCX, or TXT file up to 10 MB.
- `GET /documents/sources` lists sources belonging to the current visitor.
- `DELETE /documents/source` removes a source for the current visitor.
- `POST /documents/search` retrieves relevant chunks.
- `POST /rag/stream` streams a grounded answer as server-sent events.
- `DELETE /session` deletes all chunks belonging to the current visitor.

State-changing routes require the CSRF token from `/session`. The frontend
handles token refresh automatically when a browser restores a stale session.

## Astra DB requirements

The configured vector collection must index both `source` and `ownerId`. The
backend always applies `ownerId` from the server-managed visitor cookie, so a
frontend cannot select another visitor's documents. If an older collection
does not index `ownerId`, create a new vector collection and update
`ASTRA_DB_COLLECTION` before deploying.

## Long-document behavior

Documents are split into 1,500-character passages with 225 characters of
overlap. Embeddings are sent in bounded batches, serialized, throttled, and
retried for temporary provider failures. A genuinely exhausted Google quota
returns a clear HTTP 429 response so the frontend can keep the file selected
and offer a retry instead of storing incomplete vectors.

## Anonymous session cleanup

Each browser receives a random visitor cookie. The frontend sends a heartbeat
while open and schedules cleanup when the page closes. The backend removes the
visitor's chunks after the close grace period or after the heartbeat timeout.
The explicit `DELETE /session` route clears them immediately.

This is browser-level isolation, not an authenticated account system. The
in-memory cleanup timer is not a durable queue, so production deployments
that can restart or run multiple API instances should add a persistent
retention/cleanup worker and authenticated user IDs before promising stronger
data-lifecycle guarantees.

## Verification

```powershell
npm run lint
npm test
npm run build
```
