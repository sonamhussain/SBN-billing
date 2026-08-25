# SBN Billing

SBN Dubai Polyclinic Billing Software.

## Package A1.1 — Project Skeleton

One repository containing a React + Tailwind frontend and a Node.js + Express backend. The frontend calls one backend endpoint (`GET /api/health`) and shows whether the API is online.

**Scope lock:** A1.1 is engineering skeleton only. No database, no authentication, no healthcare billing rules, no real patient data (PHI). See `docs/README.md` for architecture notes.

### Run locally

Terminal 1 — backend:

```bash
cd backend
npm run dev
```

Terminal 2 — frontend:

```bash
cd frontend
npm run dev
```

Open the Vite address (normally `http://localhost:5173`). The page should show **API ONLINE**.
