# Real-photo Gemini regression set

`test/realPhotoEvaluation.test.ts` is an opt-in live test over six real,
openly licensed photographs. It covers long straight hair, short hair, curls,
a visually dominant headscarf, strong glasses, monochrome input, and formal
clothing. The test downloads 896 px thumbnails into memory, checks structured
canonical identity and salience, then discards the bytes.

Run from `workers/` with `RUN_LIVE_GEMINI_EVAL=1` and `GEMINI_API_KEY` in the
process environment. It is skipped during ordinary unit tests so CI never
needs a production secret or network access.

Set `RUN_LIVE_GEMINI_FULL=1` to run the additional end-to-end image-mode smoke
test. Analysis and critique use the same `gemini-3.6-flash` model configured
for the Worker so the regression score reflects production behavior. If its
small free request bucket is exhausted, the harness uses the production
`gemini-3.1-flash-lite` fallback instead of failing the whole pipeline.
Override these with `LIVE_GEMINI_VISION_MODEL` and
`LIVE_GEMINI_FALLBACK_MODEL` only when comparing model versions. Image mode
still requires an account with a non-zero
`gemini-3.1-flash-image` quota. Free projects may report image quota `0`; in
that case the app safely returns its deterministic procedural skin and the live
image-mode assertion remains unavailable until billing or image quota is
enabled.

Set `RUN_LIVE_GEMINI_PROCEDURAL_QA=1` to analyze the headscarf case, build the
exact deterministic fallback atlas, render its six required 3D views, and ask
Gemini to apply the same strict likeness thresholds. This path does not need
Gemini image-generation quota and catches regressions in the fallback that
ordinary structural tests cannot see.

Use `LIVE_GEMINI_PROCEDURAL_CASES=all` to run that full 3D quality loop over
all six photographs, or provide a comma-separated list of case IDs such as
`long-straight-hair,glasses-monochrome`. If omitted, the focused headscarf case
remains the default so a routine live check uses only two Gemini requests.

Set `RUN_LIVE_GEMINI_MULTI_PHOTO_QA=1` to exercise upload-order-independent
canonical integration with two public-domain photographs of the same person:
a close portrait is uploaded first and a full-body view second. The test
requires Gemini to choose the portrait for face/hair evidence, the full-body
view for outfit and generation composition, fuse the visible regions without
inventing covered lower-body details, render the exact procedural atlas from
six 3D views, and pass the strict likeness critique against both sources.

For local visual diagnosis, set `LIVE_GEMINI_DEBUG=1` to print the public
photo's structured feature analysis. Set `LIVE_GEMINI_ARTIFACT_DIR` to a
temporary directory to save the generated atlas, six-view montage, and
analysis JSON. Neither option writes the API key or source photograph.

After an analysis JSON has been saved, renderer changes can be compared
without another Gemini request. Set `REPLAY_ANALYSIS_JSON` to that JSON and
`REPLAY_ARTIFACT_DIR` to a temporary output directory, then run
`npm run replay:analysis`. The replay uses the same normalization, palette,
style, atlas validation, UV masking, and six-view renderer as production.
It also accepts a saved `/api/generate` response, including unsuccessful
responses that contain analysis plus a hex feature palette, so production
failures can be reproduced without another provider call.
Optionally set `REPLAY_SOURCE_IMAGE` and `GEMINI_API_KEY` to save a fresh
Gemini critique beside the replayed artifacts. Set
`REPLAY_REQUIRE_APPROVAL=1` when the replay should act as a strict likeness
gate rather than a diagnostic capture.

For a multi-photo replay, set `REPLAY_SOURCE_IMAGES_JSON` to a JSON array of
up to five local source-image paths instead of `REPLAY_SOURCE_IMAGE`. The
sources remain in memory and are compared together against the same six-view
montage, matching the production critique path.

To inspect a correction without exporting the source photograph or making a
new model request, set `REPLAY_CRITIQUE_JSON` to a previously saved
`SkinCritique` JSON object. The replay writes additional `*-corrected-skin.png`,
`*-corrected-six-view.png`, and `*-correction.json` artifacts using the same
analysis-grounded procedural correction path as production.

For a human-reviewed endpoint diagnostic, set
`REPLAY_HAIR_LENGTH_OVERRIDE` to `cropped`, `ear`, `jaw`, `shoulder`, `chest`,
`waist`, or `hip`. This changes only the offline replay's overall and side hair
length, so the original and landmark-corrected 3D silhouettes can be compared
without another provider request. It is an evaluation override, not an input
to the production generation route.

An exact PNG returned by a deployed Worker can be inspected without invoking
either AI provider. Set `RENDER_SKIN_PNG` and `RENDER_SKIN_ARTIFACT_DIR`, then
run `npm run render:skin`. The harness first applies the final Java-atlas
validator and rendered-view inspection, then writes the same six-view plus
head/torso-close-up montage used by production critique. Set
`RENDER_SKIN_GEOMETRY=slim` only for an already converted Java Slim atlas.

Sources and licenses:

- [Portrait of a young long-haired woman](https://commons.wikimedia.org/wiki/File:Portrait_of_a_young_long-haired_woman.jpg) — Vladimir Pustovit, CC BY 2.0.
- [Smiling Lao woman with short hair and red shirt](https://commons.wikimedia.org/wiki/File:Smiling_Lao_woman_with_short_hair_and_red_shirt.jpg) — Basile Morin, CC BY-SA 4.0.
- [Smiling senior woman with curly hair portrait](https://commons.wikimedia.org/wiki/File:Smiling_senior_woman_with_curly_hair_portrait.jpg) — Shixart1985 / Nenad Stojković, CC BY 2.0.
- [Nasiim Mohomed Ali Aar with a blue and pink headscarf](https://commons.wikimedia.org/wiki/File:ASC_Leiden_-_van_de_Bruinhorst_Collection_-_Somaliland_2019_-_4470_-_A_portrait_of_Nasiim_Mohomed_Ali_Aar,_author_of_the_novel_Between_Love,_Past_and_Destiny,_with_a_blue_and_pink_headscarf_in_Xarunta_Dhaqanka_ee_Hargeysa.jpg) — Gerard van de Bruinhorst / African Studies Centre Leiden, CC BY-SA 4.0.
- [Black and white self-portrait with coke bottle glasses](https://commons.wikimedia.org/wiki/File:Black_and_white_self-portrait_with_coke_bottle_glasses.jpg) — cosmic_bandita, CC BY-SA 2.0.
- [Neil Patrick Harris cropped portrait](<https://commons.wikimedia.org/wiki/File:Neil_Patrick_Harris_(9449178210)_(cropped_portrait).jpg>) — vagueonthehow, CC BY 2.0.
- [Smiling Bill Parsons portrait crop](<https://commons.wikimedia.org/wiki/File:Smiling_Bill_Parsons_portrait_-_White_Studio_(cropped).jpg>) and [the full-length original](https://commons.wikimedia.org/wiki/File:Smiling_Bill_Parsons_full-length_portrait.jpg) — White Studio, published 1918, public domain in the United States.

These images are evaluation inputs only. They are not bundled with the app,
redistributed by this repository, or used for model training.

## 2026-08-22 strict identity-architecture probe

After raising the production approval floors to identity 88, face/hair 85,
outfit 78, consistency 82, and layer 70, the public headscarf procedural case
was rerun without saving the source photo or API response. Both P5 constraints
were verified as present (dark brown complexion and the patterned grey/pink
headscarf), but the candidate correctly failed the new aggregate gate at
68/65/72/70/68. This is retained as a known quality failure, not converted to
a pass by lowering thresholds. The next renderer work for this case is a more
specific wrapped-cloth pattern/shading template and stronger face likeness
clusters under the head covering.

## 2026-08-22 same-person multi-photo regression

The live multi-photo QA used the public-domain portrait crop and full-length
White Studio photograph of Smiling Bill Parsons. The close portrait was
intentionally uploaded first and the full-body image second. Two independent
Gemini analysis passes both selected image 0 for portrait identity and image 1
for outfit ownership and generation composition. The fused analysis reported
`full_body`, observed face through feet, and correctly left the visible lower
body and shoes uninferred.

The first six-view render exposed a real renderer gap: although analysis
correctly identified a bald crown with short side/back hair, the coarse
fallback enum still said `short` and produced a full brown fringe. The general
fix now lets high-priority canonical baldness override the coarse enum, authors
a skin-toned crown plus a tapered horseshoe on every base UV face, and adds a
sparse coherent side/rear outer layer after portrait-overlay cleanup. Soft
eyebrow and mature-smile evidence also selects restrained one-row eyes, subtle
brows, nose shading, and a compact tooth line instead of a dark eye mask or
square protruding mouth.

An offline replay of the saved analysis passed strict Gemini review at
identity 85, face/hair 82, outfit 88, consistency 90, and layer 75. A fresh
end-to-end run then repeated analysis, procedural generation, exact 64x64
validation, six-view rendering, and critique without replaying model output;
it passed at identity 80, face/hair 78, outfit 85, consistency 82, and layer 80. The only remaining feedback was minor: the deterministic formal-jacket
overlay can still read as more dotted than woven at enlarged scale.

## 2026-08-22 deployed fallback probe

A deployed generation used the public CC BY 2.0 Wikimedia portrait
`Smiling senior woman with curly hair portrait.jpg`. Gemini image generation
had no remaining daily image quota, and the request completed through the
Workers AI image provider. The returned 64x64 Classic atlas passed exact atlas
validation and six-view rendered inspection. The sweater knit and jeans were
readable, but the result was rejected for identity fidelity: jaw/neck-level
wide curls had been analyzed as shoulder length and became long torso-side hair
panels.

The follow-up fix adds an independently reported anatomical hair-endpoint
landmark plus an explicit shoulder-contact boolean, and refuses to create
shoulder panels when substantial locks stop at the jaw or neck. It also turns
generic canonical-identity schema keys such as `hairColor` and `topType` into
concrete evidence-bearing cues. An offline replay of the saved production
analysis confirmed that changing only the reviewed endpoint from shoulder to
jaw removes the invented panels while preserving the curly crown and outfit.

The focused `curly-hair` live procedural QA was then rerun against Gemini with
the new code. The primary and focused analyses both selected jaw length; the
focused evidence said that the lowest curls ended clear of the shoulder seam.
The generated Classic atlas passed exact validation, six-view inspection, and
the strict Gemini likeness critique. The saved montage retains the rounded
curly crown, gray cable-knit sweater, and jeans without torso-side hair panels.
This validates the live analysis and deterministic correction path, but is not
a new deployed image-provider result; that final check still requires an image
quota reset and deployment of the change.

## Earlier local strict run (2026-08-13)

The production analysis/fallback path was rendered as an exact 64×64 Java
skin and reviewed from six full-body views plus head/torso close-ups.

- `glasses-monochrome`: passed the strict likeness gate after restoring dark,
  round statement frames and removing unsupported hidden-lower motifs.
- `short-hair-formal`, `short-hair-red-shirt`, and `curly-hair` were rejected
  by the last live strict critique. That critique predates the renderer changes
  below, so none of these cases is recorded as a pass yet.

The saved analyses were then replayed through the exact current production
renderer without another model call. The deterministic comparisons show:

- `short-hair-red-shirt`: the tooth row is now compact rather than an open
  white bar, smile corners remain readable, and the side-swept fringe falls
  opposite the visible root part. Contradictory stale formal-trouser inference
  is also replaced with casual jeans and sneakers when the observed top is
  explicitly athletic.
- `curly-hair`: jaw-length side volume remains above the shoulders and each
  outer-layer curl loop now exposes a darker base-layer cavity, making the
  curls distinct from a flat helmet from front, side, and rear views. Replaying
  the previous major “flat curl depth” critique through the production
  procedural-correction path further separated light curl rings from their
  dark cavities while leaving every pixel outside the head outer layer
  byte-for-byte unchanged.
- `short-hair-formal`: crown and second-row alpha notches add visible depth to
  the upward spiky silhouette, while the striped tie and open jacket remain
  readable. The limited 8×8 head geometry still makes the quiff less tall than
  the source photograph, so this remains a known likeness limitation rather
  than a claimed pass.

A fresh Gemini approval/rejection was not requested for these local source
images because exporting them from this workspace was not authorized. The
replay artifacts therefore provide deterministic visual evidence, not a new
external critique score.

When image generation is unavailable in production, the validated procedural
atlas now enters the same six-view Gemini critique stage. Major/critical
feedback can trigger one bounded re-render that only strengthens details
already present in structured analysis (hair geometry/contrast, face geometry,
outer-garment depth, observed chest graphics, or an observed tie). Minor or
unsupported suggestions are ignored, and corrected atlases must pass the same
render inspection and final Java-skin validation before replacement.

The full Gemini image-mode smoke test reaches both the configured quality image
path and a minimal, non-personal `gemini-3.1-flash-lite-image` probe, but this
Google project currently reports free-tier request and input-token quota
`limit: 0`. Structured analysis and deterministic fallback remain operational;
image-mode completion must be rerun after image quota or billing is enabled.

## Current diverse strict matrix and local API probe (2026-08-22)

The current renderer was re-evaluated against distinct public photographs,
using the exact six-view montage and the production Gemini critique thresholds.
The following runs passed:

- `curly-hair`: jaw-ending curls, cable-knit sweater, and jeans passed after
  the endpoint/shoulder-contact fix removed invented torso hair panels.
- `headscarf-color-blocks`: the patterned grey/black headscarf, pink side cue,
  dark complexion, and dark outfit passed as one coherent 360-degree model.
- `glasses-monochrome`: identity 85, face/hair 80, outfit 75, consistency 90,
  layer 70. Large round frames, readable dark eyes, irregular loc gaps, and a
  deliberately plain dark outfit survived every view.
- `short-hair-red-shirt`: identity 85, face/hair 88, outfit 92, consistency
  95, layer 90, with no reported defects. A prior current-code render scored
  75/70/85/90/65 because the tooth row read as a flat white bar and the compact
  side-parted crown lacked depth. The general fix gives non-flat, side-parted
  short cuts a stronger authored shade ramp and preserves lifted smile corners
  for mature tooth-visible expressions.
- `long-straight-hair`: identity 85, face/hair 80, outfit 90, consistency 95,
  layer 85. The current result preserves long wavy brown hair, turquoise drop
  earrings, a white strapless ribbed top, and a pink lower garment. The fix is
  semantic rather than photo-specific: named lower-garment colors now outrank
  generic denim defaults, shoe colors cannot leak across garment clauses,
  `ribbed` selects texture without converting a tube top into a sweater, and
  strapless/tube/tank/camisole evidence produces a true sleeveless arm map.
- Same-person portrait plus full-body integration: identity 80, face/hair 78,
  outfit 85, consistency 82, layer 80, with portrait and outfit roles selected
  independently of upload order.

A deployment-free local Worker QA then exercised the real `/api/generate`
route with remote Workers AI and local-only KV state. Gemini's configured image
models still had no usable quota, so Workers AI returned two image candidates;
both were correctly rejected because the generated sheet lacked a usable back
view. The same request initially exposed a procedural safety-net defect: wide
eyes placed their outer corners on the head seam, where valid long side hair
made the craft checker report both irises as occluded. The general fix keeps
the inner iris anchors transparent, permits the outer eye corner to remain
behind physically continuous side hair, and reapplies face readability as the
last composition invariant. A dedicated regression now covers this exact
geometry without weakening the existing hidden-eye rejection tests.

After that fix, the live endpoint returned HTTP 200 with a validated 64×64
procedural fallback. Its PNG was byte-for-byte identical to an offline replay
(matching SHA-256), passed exact Java-atlas validation and six-view rendered
inspection, and passed a fresh strict Gemini comparison at identity 85,
face/hair 80, outfit 90, consistency 95, and layer 85. This proves the complete
analysis → image-provider attempt → deterministic validation/fallback → real
3D render → Gemini critique path while continuing to reject malformed
image-provider sheets rather than exposing them to users.

## Identity-stage A/B diagnosis (2026-08-22)

The evaluation harness now saves only a focused source crop and derived stage
images under the gitignored `evaluation-artifacts/` directory. It compares the
existing composed head (A) with an analysis-derived `FacePixelPlan` head (B)
from front and both front three-quarter angles, then runs the unchanged strict
absolute critique on the selected result. No threshold or P5 rule was relaxed.

| case | provider | identity before → after | face/hair before → after | P5 | selected | largest loss stage | correction | craft |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| short-hair-red-shirt | deterministic renderer | 85 → 85 | 80 → 80 | all present → all present | B (`FacePixelPlan`, pairwise confidence 0.85) | procedural composed face | none | valid; only head-front landmarks changed |
| glasses-monochrome | deterministic renderer | 85 → 85 | 90 → 90 | all present → all present | A (pairwise tie) | analysis/8×8 compression | none | valid and unchanged |
| headscarf-color-blocks | deterministic renderer | 85 → 85 | 80 → 80 | all present → all present | A (pairwise confidence 0.85) | analysis/8×8 compression | none | valid and unchanged |

For `short-hair-red-shirt`, pairwise review preferred B because its discrete
mouth footprint preserved the visible toothy smile more clearly. The absolute
review still held both variants at 85 identity / 80 face-hair, so this is a
real candidate-choice improvement but not a strict-gate pass. For the glasses
case, A and B were judged indistinguishable and the safe tie policy retained A.
For the headscarf case, B was judged worse and A was retained; this confirms
that the candidate mechanism does not force a plan over stronger existing
pixels or overfit to the earlier headscarf failure.

The earlier recorded headscarf run scored 68 identity / 65 face-hair. A fresh
run of the current renderer scored 85 / 80, but that cross-run delta is not a
controlled A/B measurement because analysis/model responses can vary. The
controlled same-run result is 85 / 80 before and after, with A retained. The
old-to-new delta is therefore reported as contextual evidence, not attributed
solely to the candidate-selection change.

One bounded character-sheet evaluation was attempted for the short-hair case.
The configured Gemini image models reported project free-tier image request
and input-token limits of zero before producing a sheet. No additional image
sampling was attempted. Consequently, generated-sheet → pack identity loss
could not be measured live in this run; the production code path and synthetic
regressions cover it, while live artifacts for that stage remain absent rather
than fabricated.
