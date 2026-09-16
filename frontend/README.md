# MC.AI frontend

The frontend is a responsive React and TypeScript application for uploading
documents, choosing a search scope, and asking grounded questions through the
MC.AI API.

## Configure the API

Copy `.env.example` to `.env.local` and set the API URL when the frontend and
backend are hosted on different origins:

```powershell
Copy-Item .env.example .env.local
```

`VITE_API_URL` is compiled into the browser bundle. It may be an absolute API
origin such as `https://api.example.com`. If the app and API are served from
the same origin behind a reverse proxy, it can be omitted and the browser will
use the current origin.

Do not put server secrets in any `VITE_*` variable.

## Run locally

```powershell
npm ci
npm run dev
```

The Vite development server normally runs on `http://localhost:5173`.

## Deploy to Vercel

Create the Vercel project from this repository and set its root directory to
`frontend`. The checked-in `vercel.json` provides the Vite build settings and
SPA fallback. Set this project environment variable for Preview and
Production:

```text
VITE_API_URL=https://<your-azure-api-host>
```

Redeploy after changing the variable because Vite compiles `VITE_*` values into
the browser bundle. Add the final Vercel domain to the backend's
`CORS_ORIGINS` value in Azure.

## Build for production

```powershell
npm ci
npm run build
```

The deployable static files are written to `dist/`. Serve that directory over
HTTPS from a static host or web server. Configure the API URL at build time,
for example:

```powershell
$env:VITE_API_URL = 'https://api.example.com'
npm run build
```

If using a same-origin reverse proxy, forward `/health`, `/session`,
`/documents`, and `/rag` to the backend and leave `VITE_API_URL` unset.

## Verification

```powershell
npm run lint
npm run build
```

The production page is branded as MC.AI and includes the supplied logo and
favicon assets.
