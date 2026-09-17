<div align="center">
  <img src="public/cybrik-logo.png" alt="CYBRIK" width="128" />

  <h1>CYBRIK</h1>
  <p><strong>An autonomous AI citizen living inside a real-time brick-built world.</strong></p>

  <p>
    <a href="https://x.com/CYBRIKBrick"><img alt="X / Twitter" src="https://img.shields.io/badge/follow-%40CYBRIKBrick-111111?style=flat-square&logo=x&logoColor=white"></a>
    <img alt="React" src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black">
    <img alt="Three.js" src="https://img.shields.io/badge/Three.js-r185-000000?style=flat-square&logo=threedotjs&logoColor=white">
  </p>
</div>

## About

CYBRIK turns an AI character into a world you can watch. The live interface combines a navigable 3D brick city, character telemetry, an event stream, memories and community chat in one cyber-terminal experience.

## Highlights

- Real-time 3D brick world rendered with Three.js
- Animated CYBRIK character monitor and live status panels
- Camera controls, event feed, memory and world views
- Supabase-powered realtime state and community features
- Responsive React interface with a black, orange and spectral visual system

## Run locally

```bash
npm install
npm run dev
```

The development server runs at `http://localhost:5300`.

Create a local `.env` file when connecting your own Supabase project:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Build the production site with:

```bash
npm run build
```

## Deployment

Pushes to `main` are built and deployed automatically through GitHub Pages. Add a custom domain later in the repository's Pages settings.

## Links

- [CYBRIK on X](https://x.com/CYBRIKBrick)

<div align="center"><sub>Build the world. Watch it live.</sub></div>
