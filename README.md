# MC.AI

MC.AI turns trusted PDF, DOCX, and TXT documents into searchable, grounded
answers. The project is split into two deployable applications:

- `backend/` — NestJS API, Gemini embeddings/chat, Astra DB vector storage,
  CSRF protection, and browser-session cleanup.
- `frontend/` — React/Vite interface with responsive desktop, tablet, and
  mobile layouts.

## Local development

Start the API and frontend in separate terminals:

```powershell
cd backend
npm ci
Copy-Item .env.example .env
# Fill in the Google and Astra credentials in .env
npm run start:dev
```

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:5173`.

## GitHub and production deployment

The repository is structured for the `kingsmark16/mc.ai` GitHub project. The
workflow in `.github/workflows/ci.yml` runs backend tests/builds and the
frontend build on every push and pull request.

### Vercel frontend

Create a Vercel project from this repository with these settings:

- Root directory: `frontend`
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_URL=https://<your-azure-api-host>`

`frontend/vercel.json` already includes the SPA fallback required for direct
navigation. After the Vercel domain is known, add that exact HTTPS origin to
the backend `CORS_ORIGINS` setting.

### Azure backend

`backend/Dockerfile` is ready for Azure Web App for Containers or Azure
Container Apps. Configure the service to listen on port `3005`, then add all
backend settings from `backend/.env.example` as Azure application settings or
managed secrets. Never upload `.env` to GitHub or bake secrets into the image.

For a same-origin reverse proxy, leave `VITE_API_URL` unset and forward the
frontend paths `/health`, `/session`, `/documents`, and `/rag` to the API.

## Production handoff

1. Create an Astra vector collection that indexes `source` and `ownerId`.
2. Put Google and Astra secrets only in the backend environment.
3. Set the backend to `NODE_ENV=production` and configure
   `CORS_ORIGINS` with the exact HTTPS frontend origin.
4. Build and run the backend with `npm ci`, `npm run build`, and
   `npm run start:prod`, or use `backend/Dockerfile` on Azure.
5. Build the frontend with `VITE_API_URL` set to the HTTPS Azure API origin;
   Vercel serves `frontend/dist/` automatically.
6. Keep `ENABLE_DIAGNOSTIC_ENDPOINTS=false` in production.
7. Monitor `/health`, Google embedding quota, Astra availability, and process
   logs.

Detailed setup and lifecycle notes are in [backend/README.md](backend/README.md)
and [frontend/README.md](frontend/README.md).

## Checks

```powershell
cd backend
npm run lint
npm test
npm run build

cd ../frontend
npm run lint
npm run build
```
