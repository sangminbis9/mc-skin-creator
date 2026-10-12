# Skin engine API and verification — 2026-10-13

## Structure

`src/skinEngine.ts` is the deterministic engine. It accepts a validated appearance observation, identity/garment plan, material parameters and source atlas. It has no HTTP, Worker bindings, credentials, persistence or AI dispatch. `src/engineService.ts` supplies the Cloudflare analysis adapter, reserved dispatch and public response allowlist. `src/index.ts` supplies HTTP, anonymous metrics and bounded upload parsing.

`../shared/skinLayout.ts` is the UV and anatomy source for the engine and editor. `../shared/skinIntegrity.ts` checks all six body parts and both layers, in classic or slim geometry. It repairs outside-UV content, nonbinary alpha and missing base pixels only when a trusted source pixel exists. RGB edge differences are reported, not indiscriminately smoothed: eyes, collars, sleeves and accessories intentionally cross material boundaries. Existing source-specific hair/garment ownership validators continue to enforce and repair authored connections.

## HTTP contract

`POST /v1/skins` and the existing `POST /api/generate` accept the same JSON:

```json
{"image":"data:image/jpeg;base64,...","analysisImage":"data:image/jpeg;base64,...","referenceImages":[]}
```

Inputs: canvas-preprocessed JPEG/PNG, at most 1024 pixels on either side and 1,500,000 data-URL characters each; up to four same-person references. The app keeps its 896px analysis / 448px generation preprocessing. Small sources are encoded once, JPEG metadata is removed by canvas, and temporary canvases/image sources are released.

Success preserves `ok`, `skinPngBase64`, `features`, `generationMode`, `quota`, `requestId`. PNG is a modern Minecraft 64×64 atlas. All responses include `Cache-Control: no-store` and `X-Skin-Engine-Version`. Raw observations, prompts, coordinates and detailed identity plans are not returned by public endpoints. Existing Java/Bedrock classic/slim exporters and the shared 2D/3D `SkinDocument` remain available.

This endpoint prepares a platform integration boundary; it does not implement Mojang account login, Mojang upload, partner authentication or SDK licensing.

## Free inference policy

Public endpoints enforce `workers_free_only` regardless of a configured Gemini secret or legacy generation flags. One native `@cf/google/gemma-4-26b-a4b-it` V3 analysis, temperature 0, seed 0, thinking disabled, output storage disabled, max 8192 completion tokens. No paid provider, Gateway, image generation, geometry, critique, fallback or retry executes in this path. The existing 60-second native analysis deadline is retained. Missing AI/budget bindings fail closed.

`NEURON_BUDGET` is a SQLite-backed Durable Object. A shared project allowance requires one atomic coordination point. It runs no inference; transactions reserve before dispatch and settle only from authenticated provider token usage. Concurrent isolates cannot bypass the 5000 Neurons/day project ceiling. Unknown usage, failures, crashes and timeouts retain the full reservation. Idempotent settlement cannot refund twice; day keys preserve old-day charges at UTC rollover. Counter/reservation records expire via alarms and contain no photographs, identity information or source hashes.

Rates checked 2026-10-13: 9091 input / 27273 output neurons per million tokens. Reservation covers the entire published 256000-token context plus 8192 output tokens: **2551 neurons**. This is deliberately conservative, so the app can close before measured consumption reaches 5000. Successful authenticated token usage releases unused reservation. The allowance covers this engine, not other applications sharing the Cloudflare account. It cannot guarantee account-wide zero billing if other projects consume the shared free allowance.

- Pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Gemma model/context: https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
- Native data policy: https://developers.cloudflare.com/workers-ai/platform/data-usage/

Deploy boundary: Wrangler config adds `NEURON_BUDGET` and migration `neuron-budget-v1`. Those bindings must be provisioned by Worker deployment before the new server engine is used in production. GitHub publishing and Toss bundle upload alone do not activate these backend changes.

## Privacy

Public generation does not persist photos, generated PNGs or appearance analyses. Native inference uses no Gateway logs/cache. Uploaded stream buffers are zeroed after parsing; request DTO references and app photos are released after completion. JavaScript immutable strings/runtime/provider buffers cannot be cryptographically wiped or have their reclamation time guaranteed. Requests which time out may still run in the native provider; their reserved cost is retained.

Coarse route failures store only random request ID, error class and phase for one hour; counters contain aggregate events. Device-local reuse retains only bounded input hashes, PNG and editor metadata for 24 hours, never photos or analysis. Generated skins remain in the editor/device until the user resets or downloads them. Existing historical local evaluation artifacts were not changed or deleted.

## Comparison and checks

- Same twelve frozen appearance observations, three interleaved local runs per implementation: ownership-index optimization preserved all twelve RGBA hashes. Sum of case medians: 3056.83 → 2827.86 ms (**7.49% less local rendering time**). This is a local CPU comparison, not measured network/inference latency or an SLA. Evidence: `evaluation-artifacts/engine-comparison-20261013-8XDlWG/comparison.json`.
- Normalization/face/hair/outfit/accessory constraints, frozen twelve including five calibrated cases retained. Root part, forehead opening, hair endpoints, garment closure/material and accessories receive independent observation instructions; no hidden feature is invented downstream.
- 51 unique relevant tests passed across fourteen files (one optional older reference-image inspection skipped). Tests cover public routes, no paid calls despite credentials, quota race/settlement/failures, real local workerd with 30 concurrent reservations, all body-part structural repairs, asymmetrical limbs, editor paint/erase/undo/redo, reuse, V3 schema and saved head connections.
- Frontend/Workers TypeScript, touched-file ESLint, Git diff whitespace checks, production Vite/Toss build and Wrangler deploy dry-run passed. Secret/embedded-image pattern scan: 33 source/config/test/document files, no matches. The generated runtime types were refreshed with local `wrangler types`.
- Full real-photo likeness and free-model success-rate improvement are **not established** by these tests. There was no live inference. Prompt/seed controls reduce sources of variation but do not guarantee provider determinism.
- Commercial readiness still requires deployed binding verification, free-tier real-photo success/latency tests, traffic/load abuse testing and platform authentication. Low-resolution faces, cropped/hidden regions and 8×8 facial detail remain limits. Bedrock account/platform restrictions still apply to user-selected custom skins.
