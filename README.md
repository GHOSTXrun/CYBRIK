# SILICOO

The first memecoin community you can actually watch — an AI-driven little black minifig living a full crypto life in a 3D brick world, streamed live to the people who hold the token.

Live at **https://silicoodate.com**

## What it is

SILICOO is a token whose entire community is rendered as a place. At the center of it is Silicoo: a little black minifig, driven by an AI, who keeps a real 24-hour routine, watches the real market, has real needs, writes his own memories and talks out loud — all live in the browser.

## Stack

- **React 19 + Vite** — the console UI
- **Three.js** — the 3D brick world, rendered live
- **Supabase** — realtime shared state, chat and presence
- **Claude Fable 5** — his brain (runs on a private server-side worker, not in this repo)

## Develop

```bash
npm install
npm run dev      # http://localhost:5300
```

## Build

```bash
npm run build    # outputs to dist/
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in a `.env` file for local development.

## Deploy

Pushed to `main` builds and deploys automatically to GitHub Pages via `.github/workflows/deploy.yml`.
