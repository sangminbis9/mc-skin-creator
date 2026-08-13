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

For local visual diagnosis, set `LIVE_GEMINI_DEBUG=1` to print the public
photo's structured feature analysis. Set `LIVE_GEMINI_ARTIFACT_DIR` to a
temporary directory to save the generated atlas, six-view montage, and
analysis JSON. Neither option writes the API key or source photograph.

After an analysis JSON has been saved, renderer changes can be compared
without another Gemini request. Set `REPLAY_ANALYSIS_JSON` to that JSON and
`REPLAY_ARTIFACT_DIR` to a temporary output directory, then run
`npm run replay:analysis`. The replay uses the same normalization, palette,
style, atlas validation, UV masking, and six-view renderer as production.
Optionally set `REPLAY_SOURCE_IMAGE` and `GEMINI_API_KEY` to save a fresh
Gemini critique beside the replayed artifacts. Set
`REPLAY_REQUIRE_APPROVAL=1` when the replay should act as a strict likeness
gate rather than a diagnostic capture.

To inspect a correction without exporting the source photograph or making a
new model request, set `REPLAY_CRITIQUE_JSON` to a previously saved
`SkinCritique` JSON object. The replay writes additional `*-corrected-skin.png`,
`*-corrected-six-view.png`, and `*-correction.json` artifacts using the same
analysis-grounded procedural correction path as production.

Sources and licenses:

- [Portrait of a young long-haired woman](https://commons.wikimedia.org/wiki/File:Portrait_of_a_young_long-haired_woman.jpg) — Vladimir Pustovit, CC BY 2.0.
- [Smiling Lao woman with short hair and red shirt](https://commons.wikimedia.org/wiki/File:Smiling_Lao_woman_with_short_hair_and_red_shirt.jpg) — Basile Morin, CC BY-SA 4.0.
- [Smiling senior woman with curly hair portrait](https://commons.wikimedia.org/wiki/File:Smiling_senior_woman_with_curly_hair_portrait.jpg) — Shixart1985 / Nenad Stojković, CC BY 2.0.
- [Nasiim Mohomed Ali Aar with a blue and pink headscarf](https://commons.wikimedia.org/wiki/File:ASC_Leiden_-_van_de_Bruinhorst_Collection_-_Somaliland_2019_-_4470_-_A_portrait_of_Nasiim_Mohomed_Ali_Aar,_author_of_the_novel_Between_Love,_Past_and_Destiny,_with_a_blue_and_pink_headscarf_in_Xarunta_Dhaqanka_ee_Hargeysa.jpg) — Gerard van de Bruinhorst / African Studies Centre Leiden, CC BY-SA 4.0.
- [Black and white self-portrait with coke bottle glasses](https://commons.wikimedia.org/wiki/File:Black_and_white_self-portrait_with_coke_bottle_glasses.jpg) — cosmic_bandita, CC BY-SA 2.0.
- [Neil Patrick Harris cropped portrait](<https://commons.wikimedia.org/wiki/File:Neil_Patrick_Harris_(9449178210)_(cropped_portrait).jpg>) — vagueonthehow, CC BY 2.0.

These images are evaluation inputs only. They are not bundled with the app,
redistributed by this repository, or used for model training.

## Latest local strict run (2026-08-13)

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
