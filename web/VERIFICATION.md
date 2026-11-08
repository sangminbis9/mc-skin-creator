# Deployment verification — 2026-10-24

## Follow-up — 2026-11-08: stepped hair crown

- Inset both full top edges of the sample's hair outer layer, clearing the matching side-face top rows. The narrower crown steps into the side locks while retaining a fully opaque Minecraft base cube.
- Matched colors and transparency along all four top-face seams, including the existing center part. Face, mouth/chin, outfit, UV layout, and renderer geometry are unchanged from the previous deployment.
- All 17 tests, type checks, and production build passed. Front, three-quarter, and side views were checked locally; the deployed front view rendered without console errors.
- Cloudflare version: `8f128fb6-b7d2-4a5e-b68a-139694918c71`. Production homepage and PNG returned HTTP 200; the new bundle and byte-identical sample PNG were verified.
- Web-only deployment; the Toss app and AI backend were not modified. No Git commit/push was performed.

## Update — 2026-11-08 (Asia/Seoul)

- Refined the real 64×64 sample only: centered softer lips, a highlighted narrow chin, and warm skin shading on the underside instead of a dark hair strip.
- Exactly 30 texture pixels changed; eyes, outer hair layer, outfit, and model geometry are unchanged.
- Cloudflare version: `1762b0ca-8b61-4178-8ce6-80057f8ee78f`.
- All 15 tests, frontend/gateway type checks, production build, and `git diff --check` passed. Added regression coverage for lip symmetry and the mirrored front-to-bottom chin seam.
- Local front/angled sample views and the deployed homepage front view were visually checked; no browser console errors were reported on the deployed page.
- Production homepage and sample PNG returned HTTP 200. The homepage references the new bundle, and the deployed PNG matches the local file byte for byte (SHA-256 `e6d8b25011b71e055ba154bd5f17773258870f0c0389db11132012307d18c84a`).
- Existing Toss app and AI backend were not changed or redeployed. No AI generation was requested, and no Git commit/push was performed for this deployment-only request.

## Update — 2026-10-25 (Asia/Seoul)

- Deployed the approved, real 64×64 handcrafted sample with narrower cheek/chin framing; no concept illustration is shown.
- Cloudflare version: `40fc9b08-6cab-409c-af70-c37c28f7f9ed`.
- Type checks, production build, and all 13 automated tests passed.
- Homepage and editable sample use the same texture source, with slim arms selected initially.
- Existing Toss app and AI backend remain unchanged. No new live AI request was needed for this sample-only release.

## Initial deployment

- URL: https://mc-skin-studio-web.mc-skin-creator-server.workers.dev
- Worker: `mc-skin-studio-web`
- Final version: `485c5965-e030-47f6-a69f-60ce87543e82`
- Existing Toss application and AI Worker were not modified or redeployed.

## Passed

- Production build and frontend/gateway type checking.
- Nine automated gateway and standalone-source regression tests.
- Production homepage and quota endpoint return HTTP 200.
- Actual photo generation using the existing AI-created reference asset reached the 3D result screen on the deployed site.
- Sample wardrobe combinations, pixel editor undo/redo, and preview navigation.
- Export screen creates a valid 64 by 64 PNG data URL and a native download link with the expected filename. Clicking requests a browser download; filesystem save completion was not confirmed in the embedded browser.
- Mobile layout at 390px has no horizontal page overflow; wardrobe preview remains visible with choices.
- Final desktop homepage visually inspected; no browser console errors in the final check.

## Scope and limitations

The AI generation engine is unchanged. A successful request does not establish likeness/garment accuracy or production reliability. The web demo and Toss app share the existing free AI budget; exhaustion can block new generations. Public access has no authentication, so capacity and abuse protection should be reviewed before broad distribution. Screenshots from local QA are ignored under `test-results/`.
