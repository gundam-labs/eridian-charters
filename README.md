# Meridian Charters

Members-only, quote-based charter booking and operations system for a licensed Indian operator flying partner-owned jets on domestic routes.

- **Members** request quotes, accept them, manage passenger manifests and download invoices.
- **Sales** price and send quotes, manage members and invites, and mark invoices paid.
- **Ops desk** runs the fleet calendar, assigns aircraft and crew, confirms charters and blocks aircraft for maintenance.
- **Pilots** see their assigned flights and log block times and defects from a phone.
- **Admin** manages users, airports and settings (GST rate, night-halt fee, quote validity and so on).
- **Listers** — charter operators, travel agents and private flyers — sign up at `/register`, post empty legs on their own aircraft and confirm requests from the public. Sales or admin verify each lister at **Listers** before their flights can go live.

The full contract between frontend and backend is in [SPEC.md](SPEC.md).

## Stack

| Part | Tech | Hosted on |
| --- | --- | --- |
| Frontend | React 18, Vite 5, react-router 6, axios, plain CSS | Vercel |
| Backend | Node 22, Express 4, `pg` (plain SQL), JWT, pdfkit | Railway |
| Database | PostgreSQL 16 | Railway Postgres |

## Run locally

Prerequisites: Node 20+ and a local PostgreSQL.

```bash
# database
createdb meridian            # or: createuser/createdb as you prefer

# backend  (http://localhost:4000)
cd backend
cp .env.example .env         # adjust DATABASE_URL if needed
npm install
npm run migrate
NODE_ENV=development npm run seed
NODE_ENV=development npm run dev

# frontend (http://localhost:5173, proxies /api to :4000)
cd ../frontend
npm install
npm run dev
```

Demo users (password `Meridian@2026`): `admin@meridian.test`, `sales@meridian.test`, `ops@meridian.test`, `pilot1@meridian.test`, `pilot2@meridian.test`, members `arjun.mehra@example.in`, `rajiv.malhotra@example.in`, and listers `ops@skyhopaviation.example.in` (approved operator) and `desk@wanderlusttravels.example.in` (pending agent). All members, aircraft, crew and partners in the seed are fictional.

## Tests

```bash
cd backend && npm test                      # pricing unit tests
cd backend && npm run test:lifecycle        # full lifecycle through the API (server must be running)
cd backend && npm run test:listers          # lister sign-up, approval, listings and requests (server running)
npm run test:e2e                            # browser test through the UI (both servers running)
npm run test:e2e:listers                    # lister sign-up → approval → publish → request → confirm in the browser
```

## Deploy

### 1. Railway (backend and database)

1. **New Project → Deploy from GitHub repo** → `gundam-labs/meridian-charters`.
2. In the service's **Settings → Source**, set **Root Directory** to `/backend`. Railway then picks up `backend/railway.toml` (Nixpacks build, `npm run migrate` before each deploy, health check on `/health`).
3. **+ New → Database → PostgreSQL** in the same project.
4. In the backend service's **Variables**, set:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | output of `openssl rand -hex 32` |
   | `CORS_ORIGINS` | your Vercel URL, e.g. `https://meridian-charters.vercel.app` |
   | `FRONTEND_URL` | same Vercel URL (used in invite emails) |
   | `COMPANY_GSTIN`, `COMPANY_ADDRESS` | real seller details for tax invoices |
   | `SENDGRID_API_KEY`, `EMAIL_FROM` | optional; without them emails are only logged |

5. **Settings → Networking → Generate Domain** and note the URL, e.g. `https://meridian-api.up.railway.app`.
6. Demo data: add the variable `SEED_DEMO` = `true` and redeploy. The pre-deploy step migrates and then seeds (idempotently). Never set this on the production database you'll use for real members.

The server refuses to start without a `JWT_SECRET` of 32+ characters unless `NODE_ENV` is `development` or `test`.

### 2. Vercel (frontend)

1. **Add New → Project → Import** the repo. Set **Root Directory** to `frontend`; `frontend/vercel.json` pins the Vite preset.
2. `frontend/vercel.json` rewrites `/api/*` to the Railway API, so the browser only ever talks to the Vercel domain and no CORS setup is needed. If the Railway URL changes, update the `destination` there.
3. Optional: `VITE_SHOW_DEMO_ACCOUNTS` = `true` for a demo environment.
4. Deploy.

### 3. Check

- `https://<railway-url>/health` returns `{"status":"ok","db":"ok"}`.
- Sign in on the Vercel URL as `admin@meridian.test` (demo) and open the fleet calendar.

## Before going live

- Confirm the GST rate and CGST/SGST vs IGST treatment for charter services (the 12% seed value is a placeholder) and set it under Admin → Settings.
- Replace seed airports' fees and aircraft hourly rates with real figures.
- Passenger ID numbers are personal data under India's DPDP Act; decide retention and who may see full numbers (members and pilots already see them masked).
- Set real `COMPANY_GSTIN` and `COMPANY_ADDRESS`, and configure SendGrid so invites and quote emails go out.
