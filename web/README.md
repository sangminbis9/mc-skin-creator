# Skin Studio — standalone web edition

Ad-free browser demo for product evaluation. This directory is an independent npm project: copy **only `web/`** to another location to install, build and run it. No parent-directory source imports, symlinks, Toss SDK or AIT build steps are needed.

Live demo: https://mc-skin-studio-web.mc-skin-creator-server.workers.dev

Product brief: https://mc-skin-studio-web.mc-skin-creator-server.workers.dev/#/product

Architecture: [한국어 파이프라인 설명](docs/PIPELINE.md) · [Interactive diagram](docs/pipeline-architecture.html)

## Run locally

Requires Node.js 22.18+ and npm.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. `npm run build` creates `dist/`; `npm run preview` serves it locally with the API proxy. `npm run typecheck` checks the frontend and Cloudflare gateway. `npm test` runs the isolation and gateway regression tests.

## External service dependency

Self-contained source does **not** mean offline AI. The browser/editor/sample can run without AI; photo generation requires the already-deployed `mc-skin-creator-api` Cloudflare Worker. The full AI engine is not duplicated here and its existing quotas/limits remain in effect. There are no AI credentials in this folder or the browser bundle.

- Development and Vite preview: `/api` proxies to the existing public API. Override `API_PROXY_TARGET` in `.env.local` if needed.
- Production: `server/index.ts` forwards only `/api/quota` and `/api/generate` to the `SKIN_API` service binding. No admin/stats/ad endpoints are exposed by this gateway.
- This demo shares the existing account's free AI budget with the Toss app. No paid tier was enabled. When quota is exhausted, sample editing/export remains available.
- The gateway is public, not access-controlled. Same-origin checks mitigate browser cross-site requests but are not authentication. Before a public marketing campaign, evaluate abuse protection (e.g. Turnstile/access control), separate quota allocation and capacity. No guarantee of production availability is implied.

## Deploy to the connected Cloudflare account

```sh
npx wrangler auth create mc-skin-new
npx wrangler auth activate mc-skin-new .
npm run cf:types
npm run deploy
```

The included config deploys **`mc-skin-studio-web`**, not the live Toss API. It uses a service binding to `mc-skin-creator-api` in the same account. For a different account, change `account_id` and the service binding to an available compatible API. Cloudflare credentials are stored by Wrangler, not in this project.

For a static-only host, set `VITE_API_BASE_URL` before building and update the `connect-src` policy in `public/_headers`. With the default configuration, deploy through Wrangler so the same-origin API routes exist.

## What is included

- English product introduction and product-evaluation brief (`#/product`).
- Native file upload and drag-and-drop, maximum five photos, consent before upload.
- Live AI generation against the existing engine; no fabricated fallback success.
- Real 64×64 sample atlas (clearly marked as curated), 3D rotation and editor.
- Landing and editor use the same real pixel-authored 64×64 lace-outfit skin from `src/lib/curatedLaceSkin.ts`, initially displayed with slim arms. No concept illustration is displayed as a skin.
- Hair / upper / lower combinations, classic/slim export, browser downloads and sharing.
- No advertising SDK, no ad placements, no client analytics requests.
- Browser-local completed-skin cache (up to 24 hours); privacy details and cache deletion at `#/privacy`.

## Provenance and limitations

The renderer, wardrobe and editor are a source snapshot of the parent project at `be3019c8e25a5f5d99e3270ba7d1132fc9552c66`. They are copied intentionally, not imported from the parent. Future engine/editor updates need deliberate syncing into `web/src` and `web/shared`.

The reference portrait and curated atlas were copied from existing project assets. The portrait is AI-created; the sample is not evidence of a new live-generation result. A commercial transaction still needs asset/IP review. No official Mojang/Microsoft/Xbox association is claimed. Console import / Marketplace publication is not implemented. AI likeness and unseen-angle inference remain imperfect. This is a reviewable product demo, not a claim that an acquisition or integration has been approved.

Only `dist/` is uploaded as static assets; source, environment files, tests and local photos are not published. Search engine indexing is discouraged but the link remains publicly accessible.
