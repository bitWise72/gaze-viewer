# Gaze Interview Viewer

Client-side tool to review `_final_camera.mp4`, `gaze_result.json`, and `calibration/` frames from downloaded interview folders.

## Run locally

```bash
cd gaze-viewer
npm install
npm run dev
```

Open http://localhost:5179 — use **Interview folder** and select a folder under `~/Downloads/pf-recordings-<clientId>/<interviewId>/`.

## Deploy (static, free tier)

```bash
npm run build
```

Upload the `dist/` folder to Netlify, Vercel, GitHub Pages, or Cloudflare Pages. No server or env vars required.
# gaze-viewer
