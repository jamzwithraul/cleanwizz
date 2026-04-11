# Clean Wizz — Deployment Guide

## Architecture

```
Frontend (React/Vite)  ──►  Vercel / Netlify (static)
Backend (Express)      ──►  Railway / Render / Fly.io (Node.js)
Database               ──►  Supabase (PostgreSQL)
Email                  ──►  Resend
```

---

## Step 1 — Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Note your **Project URL** and **API keys** (Settings → API)
3. Open the **SQL Editor** and run the full contents of `supabase/schema.sql`
   - This creates all 5 tables, indexes, RLS, and seeds default settings + promo codes

---

## Step 2 — Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # service_role key (NOT anon key)
SUPABASE_ANON_KEY=eyJ...           # optional, for future client-side use

RESEND_API_KEY=re_xxxxxxxxxxxx
FROM_EMAIL=quotes@yourcleaningbusiness.ca
BASE_URL=https://your-backend-url.com
```

> ⚠️ **Never expose `SUPABASE_SERVICE_ROLE_KEY` in the browser or frontend.**
> It bypasses Row Level Security and must only be used server-side.

---

## Step 3 — Deploy Backend (Railway recommended)

### Option A: Railway

1. Push the repo to GitHub
2. New project on [railway.app](https://railway.app) → "Deploy from GitHub"
3. Set environment variables (all from `.env.example`)
4. Railway auto-detects Node.js; set the **Start Command** to:
   ```
   node dist/index.cjs
   ```
5. Set the **Build Command** to:
   ```
   npm run build
   ```
6. Railway assigns a public URL — copy it into `BASE_URL` env var

### Option B: Render

1. New → Web Service → Connect GitHub repo
2. Build command: `npm run build`
3. Start command: `node dist/index.cjs`
4. Add all env vars in the Render dashboard
5. Copy the Render URL into `BASE_URL`

### Option C: Fly.io

```bash
fly launch
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESEND_API_KEY=...
fly deploy
```

---

## Step 4 — Deploy Frontend (Vercel)

The frontend is a pure static SPA (no server-side rendering needed).

### Vercel (recommended)

1. Import repo on [vercel.com](https://vercel.com)
2. Set **Framework Preset** → Vite
3. Set **Build Command** → `npm run build`
4. Set **Output Directory** → `dist/public`
5. Add one environment variable:
   ```
   VITE_API_BASE=https://your-backend-url.com
   ```
   (Only needed if you separate frontend/backend deployments)
6. Deploy — Vercel gives you a `*.vercel.app` URL

### Netlify

```bash
npm run build
netlify deploy --dir=dist/public --prod
```

---

## Step 5 — Configure CORS (if frontend/backend on different domains)

If your frontend (Vercel) and backend (Railway) are on different domains, add to `server/index.ts`:

```ts
import cors from "cors";

app.use(cors({
  origin: "https://your-frontend.vercel.app",
  credentials: true,
}));
```

And install: `npm install cors @types/cors`

---

## Step 6 — Configure Resend

1. Sign up at [resend.com](https://resend.com)
2. Add and verify your sending domain (e.g., `cleanwizz.ca`)
3. Create an API key with "Send" permission
4. Set `RESEND_API_KEY` and `FROM_EMAIL` in your backend env vars
5. Test by creating a quote and clicking "Send Quote"

---

## Supabase Schema Reference

```sql
-- Run this in Supabase SQL Editor
-- Full file: supabase/schema.sql

clients        -- Client records (name, email, phone, address)
quotes         -- Quote records with pricing snapshot and status
quote_items    -- Line items per quote
promo_codes    -- Discount codes (percent or fixed)
settings       -- Single-row pricing configuration table
```

---

## Local Development

Without Supabase env vars, the app falls back to **SQLite** automatically:

```bash
npm install
npm run dev       # starts on http://localhost:5000
```

With Supabase:

```bash
# Set env vars in .env, then:
npm run dev       # connects to Supabase
```

The console will print which backend is active:
- `[storage] Using Supabase PostgreSQL backend`
- `[storage] SUPABASE_URL not set — using SQLite (dev mode)`

---

## Modified Files Summary

| File | Change |
|------|--------|
| `server/storage.ts` | Refactored: extracted `IStorage` sync interface, added `getStorage()` factory, SQLite wrapped in async adapter |
| `server/storage.supabase.ts` | **NEW** — Full Supabase implementation of `IStorageAsync` |
| `server/routes.ts` | All handlers converted to `async/await`, now uses `getStorage()` |
| `supabase/schema.sql` | **NEW** — PostgreSQL schema (run in Supabase SQL Editor) |
| `.env.example` | **NEW** — Template with all required environment variables |
| `client/src/pages/Dashboard.tsx` | Minor: fixed Button variant type error |
| `client/src/pages/QuoteDetail.tsx` | Minor: fixed Button variant type error |
| `package.json` | Added `@supabase/supabase-js` dependency |

**Unchanged:** All frontend pages, components, pricing logic, email template, Drizzle schema types.
