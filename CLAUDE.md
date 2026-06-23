# Orbot V2.0 — Claude Instructions

## Design

Before writing or editing any UI (HTML, CSS, Tailwind classes, JS-rendered markup), read `DESIGN.md` first. It defines the color tokens, typography rules, component patterns, and do's/don'ts for Orbot's dark sci-fi aesthetic. Key rules:

- JetBrains Mono for all data values (SKUs, IDs, timestamps, file names, weights)
- Outfit for headings and button labels
- Lime (`#a4e844`) is the only primary action color — one per section max
- All cards use glassmorphism (`glass-panel` pattern) — never flat opaque backgrounds
- Product type colors: DS = steel-blue `#7ea6e8`, WM = peach `#ffaa6b`, FWM = orange `#ff8c00`

## Frontend

- `app.js` is the entire frontend (~4100 lines). Bump `?v=X.X.X` in `index.html` after every `app.js` change (current: `1.5.3`).
- `index.css` holds all custom CSS. Tailwind handles utilities.
- Vercel serves static files — no server-side rendering, no env vars at runtime. Supabase credentials come from localStorage (`orbot_supabase_url`, `orbot_supabase_key`).

## Backend

- `main.py` is the entire backend (~3200 lines), FastAPI on Railway.
- Railway auto-deploys on push to `main`.
- Do not use `maybeSingle()` from supabase-py — use `.limit(1).execute()` and index `r.data[0]`.
- When fetching from Railway in JS, use `response.text()` then `JSON.parse()` — never call `.json()` directly, as Railway returns HTML on 5xx errors.

## Commits

Push `main.py` changes and frontend changes in separate commits so it's clear what triggered a Railway redeploy vs a Vercel deploy.
