# Deployment verification — 2026-10-24

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
