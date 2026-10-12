# Reference-style Minecraft skins

The photo↔skin examples supplied for this Goal are **design references**, not a
dataset to copy pixel-for-pixel and not a provider calibration scale. The target
is an intentional, eye-led face, recognizable hair and well-constructed clothing.
No external image generator, demographic classifier or new provider stage is
required for deterministic styling.

The direct eight-pair photo/atlas review and measured layer evidence are recorded
in [REFERENCE_PAIRS_MANIFEST.md](REFERENCE_PAIRS_MANIFEST.md). Those measurements
are descriptive, not universal alpha budgets or production pixel templates.

## Evidence and design are different

`PhotoAnalysis` / geometry owns what was observed and where the eyes belong.
`ReferenceStylePlan` owns how to simplify those traits. Its provenance is
`template_design`, never `observed`, `identity_geometry` or a fake measurement.
Names such as `soft_feminine_calm` and `clean_masculine_soft` denote aesthetic
families; they do not classify the subject's actual gender. Candidate selection
uses existing structured traits and positive, category-local source evidence.
Inferred completion cannot create braids, bows, flowers, a beanie or a uniform.
Keep source complexion, iris/hair palette, facial hair and eyewear. A pretty
template is not permission to erase a beard, change skin tone or overwrite measured eye geometry. Categorical eye presentation may add an explicitly contracted paired upper catch without altering canonical openness/footprint or the source-plan landmarks; this is authored design, not recovered observation.

When real hair/covering owns both upper cells, the explicit `paired_lower_pigment`
design policy may instead paint a light catch at each original singleton anchor
and exact source iris pigment in the next lower free skin cell. This changes
presentation, not source measurements or canonical openness. Both sides must
clear hairline, mouth, other landmarks and outer-layer ownership; measured,
protected, asymmetric and glasses cases opt out. Historical plans without the
policy retain their original output. It neither erases headwear nor invents
geometry or modifies the provider contract.

Cap/beanie cloth uses the same bounded material footprint as its painter.
Unmeasured categorical brow paint inside that footprint is recorded as
`headwearOccludedBrows` and omitted before ownership resolution, rather than
punching face windows through the hat. Original brow observations and layout
remain intact. Measured/protected eyes, visible brows outside the footprint and
other covering kinds retain their existing handling.

## Face library

| Family | Finish | Nose budget | Mouth budget |
| --- | --- | ---: | ---: |
| soft_feminine_calm | soft eyes, clean complexion | 0 | 0 for eligible neutral omission; otherwise retained source |
| soft_feminine_doll | restrained upper lash | 0 | 2 |
| cute_pastel | bright iris emphasis | 0 | 2 |
| clean_masculine_soft | clean eye cluster, smooth shading | 1 | 0 for eligible neutral omission; otherwise retained source |
| cool_androgynous | neutral clean eye-led face | 0 | 2 |
| dark_stylish | restrained upper rim | 0 | 2 |

Eyes must remain the most readable clusters. Preserve measured spacing,
openness, tilt, expression and valid glasses; do not regress exact geometry to a
generic face. Nose contrast is absent or almost absent. Mouth contrast is lower
than iris contrast. Keep cheek/jaw shading to a small connected ramp rather than
isolated speckles. Blush is a design accent permitted only in the doll/pastel
families, not a new source trait. A retained mouth keeps the source contract's
minimum width even without a priority-5 flag; the two-cell finish budget cannot
erase an observed wide mouth. Open-mouth/teeth/corner expressions preserve their
existing topology. Only explicitly eligible neutral presentation may omit the
mouth, without deleting source identity or relaxing the general validator.

Reject eye/fringe/glasses collisions and unsupported mouth relocation. Aesthetic
scoring cannot override geometry validity, P5 retention or source provenance.

## Hair library

Nine initial families: short shaggy, short soft, medium layered, straight long
with bangs, wavy long with bangs, twin braids, twin tails, pastel straight long,
hoodie/beanie-compatible hair. Paired styles require observed paired sections.
The generic `preserve_existing` route retains source-specific bald/buzz, curl,
coily, bun and head-covering grammars rather than inventing loose hair.

The inner head carries the complete primary hair mass; removing the outer layer
must leave a recognizable hairstyle. Outer accents are fringe edges, temples,
side locks, crown edges, braid fronts and tied/accessory sections. No filled
outer crown plane or four-sided rectangular helmet. The family-specific outer
hair ratio is 18–30%, a proposed design budget, not a provider measurement.

For an unmeasured medium-layered style, the combination of a tousled silhouette
and staggered fringe breaks the raised crown into two short runs. Only the top
row and supported UV seam partners change; the inner foundation and next fringe
row stay intact. This relief is authored design, not a new root part or scalp
window. Smooth/blunt, measured, covered, tied, short and long styles retain their
existing rules. Actual F004 replay changes four outer cells, not its analysis,
length, face coordinates, palette or clothing.

Hair ownership must be explicit. RGB similarity is insufficient: a brown shirt
must not be erased as hair. Upper outer shoulders include the top plane and
first two rows of vertical torso/arm faces. They are hair-free by default.
A positive observation of long hair draping over shoulders may allow one named,
connected side-lock column per face, never the whole top plane. Length alone or
inferred back hair does not authorize front/arm drape. A renderer must validate connection
to the originating base-layer bottom head lock, not merely attach a `drapeGroup`
label. A same-group contiguous path must reach the upper torso before it can
continue to the physically adjacent arm edge. Detached named strands fail.

## Outfit library

Eight families: casual knit/cardigan; clean sweatshirt; pastel top; ribbon
top/skirt; school/cardigan uniform; dark hoodie; black floral streetwear; pastel
hoodie. Garment base, sleeve termination, lower garment and color blocks remain
source-derived. Retain signature observed cuffs, scarf, ribbon, collar, belt,
pleats, cargo pockets and sleeve graphics.

Patterns live mainly on the base. An outer layer marks physical construction,
not every stripe/check/flower. Templates authorize **placement** of an observed
motif, never invention of one. Avoid full sleeve or trouser shells. A hoodie
must retain its collar/hood opening without filling all torso faces. Accessories
and non-hair head coverings require their own structural budgets; never prune
them by a hair-color heuristic.

A closed/pullover hood opening is local neckline construction, not evidence of
an exposed inner-shirt panel reaching the waist. An explicitly observed inner
collar stays local; genuinely open-front clothing retains its source-supported
inner panel. Do not let a generic accent color invent layered construction.

Plain material interiors receive connected paired folds, not noise. Near-white
cloth uses a two-step inward crease rather than a clipped white highlight.
Near-black cloth uses a small neutral reflected-light ridge and a dark trough;
multiplicative highlights alone disappear on its low-value material. These are
connected planes inside source cloth, not new motif or measured color evidence.
`colorBlocks[].region = all` matching the base declares that material; it is not
an inset panel. True layered front panels/openings remain untouched, but do not
block folds on the canonical unprinted side/back material. A front-only print
protects the front; unprinted sleeve/back/side surfaces may retain their cloth
folds. Wrapped patterns remain protected on every face. Skin exposure, seam
edges, legwear and shoes are outside the fold contract.

## Surface budgets and selection

| Outer cuboid | Maximum occupied surface |
| --- | ---: |
| Head | 38% |
| Torso | 30% |
| Each arm | 25% |
| Each leg | 22% |

Denominator is the sum of the six legal UV faces, not their enclosing atlas
rectangle. Count unique owned cells, reject ownership conflicts and invalid UV
coordinates. A head covering that needs more area is a separate measured
construction case: do not silently delete it to force these ordinary style
budgets. No threshold is a proof of visual quality by itself.

Hard constraints precede candidate ranking: source-specific style eligibility,
geometry, continuity, protected accessories and base readability. Ranking is
bounded at three candidates per family axis with deterministic tie-breaking.
Prefer explicit source signature matches; neutral clean design is the safe
fallback. `referenceStyleSelection.ts` renders every eligible combination (at
most 27), then rejects source/paint/UV contract failures **and shared craft
foundation failures** before ranking. The selected atlas must pass both; a
construction-valid but under-shaded candidate cannot win. Its
deterministic heuristic uses actual iris-neighbor contrast, per-part occupied
outer area, crown coverage and isolated outer pixels, with a small evidence-fit
prior. It is not an AI evaluator or a numerical claim of photo likeness.
The eye boundary includes visible adjacent hair, including its opaque outer
layer color. Skin-only neighbors biased selection toward dim catches that
merged with side hair. This ranking correction does not repaint a candidate,
move landmarks or relax any construction/identity gate. Palette-only and
lowered-landmark study images remain offline comparisons, not authorized
source measurements or production presentation contracts.

## Integration and verification status

`referenceStyleTemplates.ts` and `referenceStyleConstraints.ts` define
and test the selection/guard contract, including hidden-hair exclusion and
physical drape connectivity. `referenceFaceFinish.ts` implements an
offline finish of soft complexion, minimal nose and subtle mouth colors, with
exact eye geometry/brow/fringe/glasses and caller-owned facial-hair protection. Its
six family palettes are exercised on real planned pixels. Paired eye rim,
under-eye softness and doll/pastel blush use available skin-window cells only;
iris, sclera, brow, hair, lens and facial-hair footprints remain protected. A
blocked pair is omitted rather than becoming a lone speck. It preserves source
teeth/opening, nonlevel mouth corners and asymmetry as an
explicit expression exception. `referencePrimaryRenderer.ts` now connects this
construction to the local default `generateSkin` primary path, before PNG
encoding. It does not change production V3, provider prompt/schema, geometry
thresholds or provider calls. The default integration was included in the
approved 2026-10-05 Worker update; later loose-hair work below remains local.
Guard tests
on authored cells alone do not prove historical atlases satisfy new budgets.

The source skin window is rebuilt as a quiet complexion foundation before
landmark finishing. The old painter shaded cells outside explicit complexion
instructions; those inherited central highlights/cheek patches could still
look like a large nose after the nose instruction was removed. Source hairline,
landmark roles and beard/covering masks authorize available skin, not RGB
similarity. A connected, small cheek/jaw ramp replaces that background without
moving eyes or changing source color categories. The verifier independently
reconstructs this finish; rewritten diagnostics cannot license a restored nose
stripe or changed lip. Hair/covering, brows, eyewear and expression keep priority.

`referenceStyleRenderer.ts` now composes real atlas pixels offline. Garment base
is rebuilt from its source plan rather than deleting hair-colored shoulder
pixels. Structural outer groups and head accents close transitive physical UV
seam units **before** budget selection. Whole groups that exceed a garment
budget remain on the base. Hair may close a seam only where every partner has
source-owned hair support; lens windows/jewelry are protected boundaries.
Coverings retain their actual pattern on a source-owned base, with a fitted
budgeted rim rather than an inflated full outer shell. Complex unresolved head
grammars are still rejected, not silently converted to generic loose hair.

Twelve stored-source comparisons currently pass outer budgets, connected
ownership, exact eye/brow geometry and constrained source-palette finishing, deterministic 64×64
PNG validity and zero non-accessory overlay seam alpha/RGB mismatches. Those
are partial construction evidence, **not complete aesthetic/craft acceptance**.
The old craft plan still expects broad outer masks and shoulder continuation.
The twelve saved faces now have no existing mouth/readability/expression
contract errors. Lips target the actual neighboring skin shade rather than a
global average; exact facial-hair protection comes from the same authored
footprint as the production painter. No craft validator or threshold has been
relaxed. Small closed mouths use a final RGB-distance design budget, not double
attenuation of an already faint lip ramp; observed expressions and protected
beard cells remain exceptions.

Composition emits an executable surface-color plan and the changed face paints.
The rendered verifier checks those against actual RGBA, independently compares
source eyes/brows, glasses and facial-hair pixels, retains owned base hair and
its palette ramp, counts actual outer coverage and detects undeclared outer
clutter and physical seam breaks. Mutation tests erase eyes, beard, hair,
garment paint or add undeclared outer pixels while leaving the declared plan
unchanged; these outputs must fail. Construction acceptance is not complete
craft acceptance. `referenceOutfitRetention.ts` now independently reconstructs
source accessory and structural primitives from the canonical outfit painter,
not the candidate's diagnostics. Ten accessory kinds, front light/shadow roles,
visible-layer ownership, later source occlusion and pattern/skin/color-block
foundations are checked. Erasing a collar and its diagnostic label still fails.
If a later base-routed cue would be hidden by an earlier outer group, the entire
surviving earlier group is also routed to base in source priority order. This
prevents opaque pleats from hiding legwear without deleting either source cue.

`ReferenceCraftPlan` snapshots original identity alongside authored style and
executable paints; it never substitutes invented geometry. Its validator checks
that identity snapshot against the authoritative source, then independent
source/paint construction plus the shared craft foundation in `skinPost.ts`.
Existing palette/shading/shell/seam/noise limits are unchanged and shared with
the legacy path. This is a different planned construction contract, not a filter
that removes failed legacy error strings. `buildProceduralSourceAtlas` produces
a legal material reference, not an approved final output. The default primary
boundary checks source foundation quality, then requires independent reference
construction and unchanged shared craft floors on the actual selected output.
The unchanged `buildProceduralFallbackAtlas` still applies its full legacy mask
contract; unresolved source grammar returned unchanged must also pass that full
contract. Old shoulder-continuation rules cannot force a styled candidate to
reintroduce forbidden shoulder hair merely to make its temporary reference legal.
Twelve stored baselines remain 12/12 craft;
selective reference construction, full reference craft and selected-candidate
craft are now **12/12**. `long-straight-hair` has 18 shaded base faces and
`full-body-layered` 20 after the source material refinements, without changing
the floor of 18. Legacy baseline/geometry hashes remain identical. Default
output atlas hashes now intentionally follow the selected reference
construction, rather than the legacy full-mask renderer. This is not aesthetic
completion or permission for deployment. Legacy validation of the same
styled atlases remains 0/12 due to its original mask/group assumptions.

The default integration test replays all twelve stored validated analyses through
the real `generateSkin` response/PNG path with mocked primary results and a
network/inference trap. Each decoded PNG must exactly equal the separately
selected reference atlas, with unchanged source plan/geometry and deterministic
replay. This is local contract evidence, not a live provider acceptance claim.
Responses expose a separate `analysis.referenceStyle` design/constraint summary;
the authoritative source SkinPlan is not replaced. Invalid source/candidates
fail without an invisible legacy rescue. Unresolved complex ownership retains
source grammar under an explicit `source_grammar_preserved` status and counts as
**zero styled candidates**, not as reference-style coverage.

Source-derived semantic coily masks now have executable ownership without
fabricating continuous geometry. Existing clipped `coily_cluster` groups may
contribute supported, seam-closed outer accents within the same budgets. Their
base material uses small connected two-cell reflection arcs. Near-black hair
adds at most eight neutral levels to a 10% light ramp, instead of multiplicative
black-on-black finishing. This is authored material shading, not a new observed
color. Exact expected base hair RGB is reconstructed from immutable source/style
data; a rewritten texture paint diagnostic cannot authorize arbitrary recoloring.
Three coily length design units pass default construction and the long unit
passes actual default PNG encoding. They are **semantic units, not three new
real-photo results**. Legacy texture masks, unresolved ornaments/locs and
unmeasured curly aperture geometry remain explicitly preserved. Promoting all
curly masks was tested and rejected because it filled a protected temple aperture.

Remaining implementation: expand unsupported hair grammar coverage and refine
eye-led aesthetic scoring and visual acceptance beyond construction metrics.
Existing old craft
failures must not be relabeled PASS just because selective masks were intended.
The nine-family composition tests select each family from its own explicit
short/medium/long/wavy/paired/pastel/hoodie semantic unit input rather than forcing
nine family names onto the same long straight source. They prove selection and
source-owned accent safety. The paired-hair construction below additionally
checks genuinely different silhouettes, not only family labels/highlights.

### Paired hair is a silhouette, not a colored curtain

`referencePairedHair.ts` derives an explicit `template_design` construction from
positive, category-local observed paired-hair evidence. It may replace only a
semantic, unmeasured rear completion: braids keep narrow rear locks around a
four-column nape window; tails fan out above a narrower, tapering nape window.
The changed base cells and complete, interior outer accents are executable
coordinates in the design contract, **not measured source hair coordinates**.
Original SkinPlan, HairPlan, FacePixelPlan, endpoints and source geometry remain
immutable. Measured hair masks, coverings, buns, accessory/face reservations or
incomplete source foundations suppress the construction rather than being
pruned to force acceptance. Source back boundaries, crown and front locks stay.

Positive shoulder-drape evidence and *both* painted bottom front locks are
separately required for paired front lengths. The first two shoulder rows use
one body-base column per side; the lower braid alternates connected two/one-cell
crossings, while the tail fans into a two-cell mass before tapering. No hair is
added to arm/torso upper outer shoulders. Length alone, inferred back hair and
rewritten diagnostic labels do not authorize the paired drape.

Candidate verification independently rederives paired nape, accents and drape
from immutable source/style data and checks actual RGBA/ownership. Rewriting a
paint diagnostic cannot license an erased lock, missing accent or braid
junction. A generic curtain cannot outrank an eligible observed paired style
solely because it has a favorable color score. The comparison fixtures are
explicit semantic design units, **not additional frozen photo evidence**.
Front/back/software-rendered PNG comparisons are saved in fresh artifact roots.
The paired-hair change alone left the frozen twelve source/style hashes
unchanged. Subsequent skin-window finishing intentionally changes styled atlas
hashes; source plans, calibrated geometry and legacy baseline hashes remain
unchanged in the twelve-case comparison. The paired construction is reachable through the
default boundary, and was included in the approved Worker update. It is not a complete likeness claim.

### Eye visibility versus eye-led design

An iris in the atlas is not necessarily visible in the viewer, and a visible
dark iris is not necessarily a readable eye. Frozen `long-straight-hair` has
two-row dark irises beside dark face-framing hair: both iris centers were
visible in the actual software-rendered front view, yet they read as extensions
of the hair columns. Outer occlusion was **not** that case's cause.

Two-row irises color their already-present lower row with a family-authored
ramp from the existing eye palette. A complete pair of one-column/two-row eyes
with no planned sclera can additionally use the curated light-catch grammar:
one light catch on each existing upper iris cell, source-colored pigment below.
This breaks the uninterrupted dark column into an eye rather than extending
the hair into the face. Family light-catch strength is 68–90% warm-white mixing,
an authored shading parameter, not a measured eye color or source sclera claim.
No new eye cell, coordinate, width, aperture measurement or color category is
invented. Singleton, wide, tilted/asymmetric and sclera-bearing eyes keep their
source grammar. A protection collision anywhere in the narrow pair suppresses
both light catches. Actual eye-cluster brow instructions are protected brows,
not additional iris cells. Lower-pigment and light-catch authorization are
derived independently from source/template data; rewriting a paint diagnostic
cannot authorize an arbitrary eye color or erase the expected catch.

Internal tone separation is measured on visible rendered iris pixels, alongside
iris-to-skin contrast. An occluded highlight earns no score. Both are bounded
readability heuristics, **not proof of an attractive finished face template**.
Frozen front-view comparison now shows the narrow eyes separating from their
dark hair frame; full face/hair silhouette refinement and broader visual
acceptance remain required before this Goal is complete.

The candidate verifier separately counts visible iris cells, unchanged source
eyewear occlusion, and accidental occlusion. Hidden irises do not contribute eye
contrast; neither do adjacent hair pixels masquerading as skin contrast. Source
sunglasses remain opaque. Frozen replay records planned/base/outer/3D-center
colors and enlarged base/outer face sheets in fresh roots, and asserts visible
iris centers actually render their base color.

Offline acceptance must cover every family, twins/curls/coverings, protected
glasses/beards/expressions, exact deterministic 64×64 UV/PNG validity, craft and
source-cue retention, per-part budget, base-first hair and real shoulder pixels.
Save fresh comparison artifacts; retain all historical baselines. Deliberate
style atlas changes must be identified separately from measurement regression.
Use existing stored analyses until offline coverage is complete; no new live
approval request is needed for library, tests or documentation work.

### Categorical curly profile openings

Unmeasured face-framing/flared curly hair no longer uses a contiguous broad
side strip. It uses a discrete crown/rear foundation plus alternating front
ringlets, with explicit temple/cheek profile openings. Side endpoint/asymmetry
still comes from the existing source categories. The ringlet cells are authored
template positions, not measured contours or new facial evidence. Measured
head silhouettes retain their existing mask and finish unchanged.

Profile openings reserve transparent outer ownership before UV seam closure;
texture groups are clipped to their hair foundation. Candidate verification
independently checks both transparent outer windows and the exposed baseline
profile material, so rewritten paint diagnostics cannot authorize filling the
cheek with hair. Actual crown accents form separated attached rises rather
than a full straight inflated rim. Near-black ringlets use small connected
neutral reflections on the existing base palette, never scattered noise or a
new hair-color category. Shoulder hair remains forbidden on outer layers.

Ear/jaw/chest examples are authored semantic design units, not additional
reviewed photos. Complex ornaments, locs, cropped-out hair, legacy masks and
curly shapes without this profile grammar remain explicitly unresolved rather
than receiving guessed geometry. Length alone does not authorize front-body
drape: only actual source-supported shoulder fall may add it. Broader visual
quality and hairstyle/outfit completeness still require further offline work.

An earlier 2026-10-05 approved Worker update (version
`cd78521e-e946-402b-a6df-bdcb49539f98`) included this curly-profile revision and
the reference default integration. The existing Toss test bundle uses that API.
Subsequent changes are not automatically deployed.

### Loose lengths and rear completion

`referenceLooseHair.ts` preserves the current categorical endpoints as authored
body-base lengths: shoulder four rows, chest eight, waist/hip twelve. Positive
category-local shoulder-drape observation and each actual bottom-front head
root authorize its front lock. The first two shoulder rows remain one column;
lower waves take connected turns without creating an upper outer rail. Length
alone, negated/inferred words and unrelated outfit evidence cannot authorize a
front lock. Paired/tied/covered/surface-only hair retains its separate grammar.

Long back hair no longer disappears when the reference composition rebuilds
garments. A rear curtain requires existing long back-shape and continuous-body
hair categories, high-confidence source-supported unseen completion, and all
six actual lower-head rear roots. Unknown, contradictory and unsupported
completion fails closed. Rear completion remains explicitly
`source_supported_unseen_completion`, not observed geometry; no source label,
HairPlan or measured coordinate is changed. Interior strand ramps and a tapered
tip are template design. Observed accessories reserve their source stencil;
any conflict omits an entire lock rather than erasing a scarf/strap or leaving a
detached fragment. Arms and all body/arm outer shoulder zones receive no hair.

The candidate verifier independently rederives the exact points, group and
palette from source/style data. An erased/recolored rear curtain still fails
even if its paint diagnostic is rewritten. Six straight/wavy endpoint semantic
units pass actual default PNG encoding with mocked primary and inference/network
traps. Frozen twelve keep every source plan, calibrated geometry, legacy atlas
and face/head pixel unchanged relative to the latest pre-change output. Only
the two already-long sources gain authorized body-base rear paints; this is an
intentional style atlas change, not zero overall atlas diff. Craft remains 12/12.

This loose-hair revision was local at the time of its first verification; it
was subsequently included in the approved Worker update recorded below.
Broader visual quality, side/back silhouette transitions and unsupported
hairstyle coverage remain further work; these tests do not complete the Goal.

### Observed long scarves

The existing OutfitPlan scarf painter retains only seven neck cells even when
source evidence explicitly describes a hanging/long scarf. Reference composition
now adds a connected, two-column body-base continuation, preserving those seven
original neck cells and their selective depth routing. Ordinary long scarves
end over the chest; an explicit waist-length claim ends before the source waist.
The source scarf palette provides a restrained crease and darker endpoint.
These positions and shading are `template_design`, not measured photo geometry.
No extra outer shell, shoulder/arm/leg paint or source-plan mutation is added.

`referenceScarfFinish.ts` accepts noun-bound positive observed construction or
existing high-confidence outfit/accessory assignments only. Long hair/cardigan
words, negation, uncertainty, low-confidence/wrong-category features and inferred
completion cannot create scarf length. In particular, OutfitPlan accessory
`evidence` is a mixed observed/inferred string and is NOT accepted as observed
length authority. A missing/ambiguous scarf or conflicting source accessory
omits the entire continuation rather than padding, repainting the other cue or
leaving detached fragments. This conservative parser is not a general language
entailment claim; unsupported wording retains the existing short neck cue.

Garment structure reserves the independently derived scarf coordinates; source
foundation verification admits only their exact palette. Candidate validation
rederives the construction from the immutable source and checks visible RGBA
and ownership. Rewriting a diagnostic cannot excuse an erased/recolored tail.
Tests exercise knit, pastel hoodie and dark hoodie semantic units through actual
default PNG encoding with mocked primary and network/inference traps. They are
design units, NOT three newly reviewed photos. The frozen twelve retain their
exact pre-scarf atlases, source plans and calibrated five geometries, craft 12/12.

This revision was initially local and later included in the Worker update
recorded below. Further reference-family visual review,
hair side/back transitions and unsupported signature-cue coverage remain open;
the long-scarf improvement alone does not complete the full reference-style Goal.

### Paired-hair categorical endpoint fidelity

Twin braids and twin tails previously used a fixed six-row front-body lock,
discarding the already observed endpoint category. Their immutable HairPlan
`semanticSilhouette.endpointCue` now selects four shoulder rows, eight chest
rows or twelve waist/hip rows. Waist and hip share the last body-base row on
this bounded atlas grammar; this is a deliberate grid representation, not a
claim that their physical lengths are equal. No guessed legacy endpoint is
substituted when that categorical authority is absent.

Paired styling still requires positive, high-confidence paired-hair evidence,
the existing unmeasured semantic head foundation and explicit shoulder fall.
Shoulder-length pairs are eligible only with the corresponding existing
categorical endpoint and complete head foundations. Geometry-derived masks,
coverings, tied masses, incomplete roots and accessory reservations remain
protected. The first two upper-shoulder rows remain one column on the body base;
arms and body outer layers receive no new hair. Braids weave through connected
two-column turns; tails preserve their full connected run and taper at the
actual categorical endpoint, rather than always at row five.

Source accessory stencils reserve their coordinates before either lock is
emitted. A strap or belt collision omits the entire conflicting lock instead
of erasing the accessory, fragmenting hair or inventing a shorter endpoint.
Only surviving locks mark their actual head roots as connected drape.
Independent candidate verification rederives endpoint, coordinates and palette
from the immutable source, so rewritten paint diagnostics cannot hide a
shortened or recolored lock.

Eight braid/tail endpoint examples are semantic design units, not eight newly
reviewed photographs. Actual default generation with mocked primary and
network/inference traps verifies their PNGs and saves all viewing angles.
The frozen twelve retain their exact pre-change atlas/source-plan hashes,
including all five calibrated geometries. This revision was later included in
the Worker update below. These fidelity checks do not establish complete visual coverage
of every reference family or finish the full style Goal.
### Short hair: bounded dimensional tufts

Short shaggy and short soft designs keep the existing source-owned inner hair
mask, categorical length, eye/brow window, accessories and calibrated geometry.
Their outer accents must not join every crown/fringe/temple into one oversized
shell: atomic budget rejection otherwise removes all dimensional accents.

- Shaggy: two small front crown rises with staggered source-supported tips.
- Soft: a shallow central front crest, with compact temple accents.
- Only source-owned cells and supported physical UV seam partners are eligible.
  Transparent eye/accessory windows remain boundaries, not gaps to fill.
- No independent top cap, jaw extension or body/arm hair is introduced.
- An unsupported accent may be omitted; measured source geometry is never
  replaced to force a visible tuft or a family label.

These positions are template-design accents, not measured hair coordinates.
The upstream generic semantic front foundation collapses short fringe categories
onto the same inner occupancy. Dimensional differentiation alone does not prove
that observed fringe details are retained; the bounded construction below
addresses only an eligible shallow central fringe, not every hairstyle.

### Short fringe: protected central negative space

`referenceShortFringe.ts` authors zero, one or two skin windows at central
front-base cells `(3,1)` and `(4,1)`. The generic semantic mask contains two
full front rows, but ownership reserves `(2,1)` and `(5,1)` for brows in the
design examples. Mask membership is therefore NOT authorization to erase a
facial cell. Windows require the actual central hair-owned foundation and
cannot intersect any explicit FacePixelPlan instruction or accessory/window
reservation. Crown/side seams, source fringe tips and facial coordinates stay
unchanged. Outer hair must not cover these windows.

Straight staggered, left/right sweep, blunt and wispy cues use bounded authored
negative-space patterns rather than fabricated continuous hair measurements.
The diagnostic labels them `template_design`; the immutable source HairPlan,
FacePixelPlan, HeadIdentityPlan and geometry are not rewritten. A measured
hairline/mask, covering, tied mass, accessory, split/long/absent fringe or
incomplete foundation fails closed. Independent candidate validation rederives
the windows from source data and checks actual RGBA, palette and ownership;
rewriting paint diagnostics cannot hide a filled or recolored window.

Four semantic units exercise distinct inner silhouettes through default PNG
encoding with mocked primary, network/inference traps and fresh before/after
views. They are authored design examples, not four reviewed photographs. Exact
before/after changes are restricted to the permitted front-base windows.
The frozen twelve and calibrated five retain their pre-fringe atlases and all
source plans/geometries. This is not a claim that all twelve have eligible
short fringes or that every reference hairstyle has full visual coverage.

### Deployment checkpoint

The approved 2026-10-05 Worker update `0e3fadef-e5e5-4421-a55f-ded0492e56d5`
included loose hair, scarves, paired lengths and bounded short dimensional
tufts. It is used by the existing Toss development bundle. The central
short-fringe revision above was implemented afterward and remains local;
no second deployment or provider call was made to verify it.

The later explicitly approved Toss development update
`f09bc94d-2a71-462b-acac-fa045284e0f9` includes the protected central fringe.
Its deployed bundle equals the local dry-run bundle exactly; read-only
`GET /api/quota` returned HTTP 200. Model/config/default Compact V3 are unchanged.
No live photo generation or mobile E2E was performed during this update.
See `evaluation-artifacts/toss-dev-worker-update-20261005-005/REPORT.md`.

## Full-family review and source-category correction

The completion review checks all six named face families, nine hair families
and eight outfit families through the actual default `generateSkin` PNG path.
`referenceFamilyCoverage.test.ts` builds valid authored semantic inputs, renders
eligible named families, independently renders/ranks the default candidates,
and checks that the decoded default PNG equals the selected atlas. It saves
baseline/default atlases, front comparisons and six viewing-angle galleries.
These are 23 authored construction units, not 23 newly measured photos.

Side/back review exposed a real upstream error in the cardigan/neck-scarf
unit: `completeCanonicalIdentityDetails` flattened separate canonical hair and
outfit claims, then accepted hair/scarf word proximity as a covering. The
unused red fallback hat palette replaced the source brown hair and the neck
scarf category was removed. Comparing only against that corrupted baseline
could not detect the source-category error.

The minimal correction keeps canonical evidence entries separate and requires
a named covering or an explicit scarf-over/around/covering-head relationship.
Hair beside a neck scarf, including within one sentence, is not sufficient.
Real hijabs/headscarves retain their named palette and patterns; negated
coverings remain negative. Covering accents are scoped to covering evidence,
not unrelated outfit panels. Measurement, template thresholds, provider wire,
normalization, fallback policy and configuration are unchanged.

The family test now compares the rendered head category against its actual
input, not only the baseline. Neck-scarf units must keep both the hair category
and the neck accessory. Focused tests reproduce the original false covering,
retain four explicit covering forms and reject three negated forms. Frozen
source plans, the calibrated five and the twelve frozen atlases are checked
separately; preserving them is not a claim that every authored design matches
a photograph or that all style changes have zero atlas diff.

This last source-category correction is local and is **not** included in
Worker version `f09bc94d-2a71-462b-acac-fa045284e0f9`. No second deployment or
live photo run was performed as part of this offline completion review.

### Original requirement-to-evidence map

| Requirement | Implementation | Executable evidence |
| --- | --- | --- |
| 1. Six minimal, eye-led face families | `referenceStyleTemplates`, `referenceFaceFinish`, rendered eye grammar | face finish, eye grammar, family coverage |
| 2. Nine inner-first hair families | `referenceStyleRenderer`, short fringe/tufts, loose and paired lengths | short/loose/paired/texture tests, six-view family galleries |
| 3. Eight selective outfit families | garment foundation/folds, observed motif/accessory retention, scarf finish | garment/outfit/scarf tests, family coverage |
| 4. Reference-driven style guide | this document: evidence vs design, face/hair/cloth, budgets | reviewed supplied atlases; no copied source pixels |
| 5. Explicit render constraints | ownership, connected drape, shoulder exclusion, per-part outer budgets | constraints, source-RGBA mutation rejection, craft tests |
| 6. Actual bounded candidate selection | up to 27 rendered eligible combinations, hard gates then scoring | rendered-score selection and rejected-source tests |
| 7. Offline regression | valid deterministic atlases, immutable source/geometry, actual default PNG | 23 semantic units plus frozen twelve/calibrated five |
| 8. Production-safe operation | default V3 unchanged; no new provider stage | mocked primary, fetch/inference traps, static checks |

Candidate scores are design heuristics, not universal attractiveness metrics.
Cuboid inner layers remain necessary; avoiding an outer helmet does not mean
the head becomes round. Complex observed ornaments outside these bounded
families stay source-preserved rather than being fabricated. Mobile photo
quality and provider availability remain separate from offline renderer proof.

### Local motif ownership (2026-10-08)

Observed floral placement is an OutfitPlan parameter, not a family-wide
permission to paint the chest and both sleeves. `surfaceParts` uses anatomical
Minecraft parts; explicitly viewer-left maps to rightArm/rightLeg. Unqualified
left/right mean wearer sides. A single unspecified sleeve, a negated/uncertain
motif, or a hidden region does not supply guessed ownership. Upper and lower
garment evidence are scoped separately. The same flower grammar scales to each
legal front surface; no reference bitmap, filename, or person selects it.

Scoped motifs are painted in the source garment foundation. Reference family
composition must not add a second bilateral motif. Plain unprinted parts retain
their material folds. Offline tests include asymmetric sleeve/leg placement,
chest-only, bilateral sleeves, negative observations, hidden completion, and
independent rejection of invented opposite-arm paint. Before/after examples are
authored semantic counterfactuals, not fresh provider observations or claims of
exact reproduction of reference E. Unspecified back-only floral placement is
not promoted to a front motif; arbitrary ornament shapes, leaf palettes, and
complex multi-location prose remain limitations to evaluate separately.

### Quiet broad cloth planes (2026-10-08)

Reference E keeps broad black cloth readable without an invented central
placket. The authored plain-sweater replay exposed a composition-stage issue:
the material finish painted adjacent light/dark columns at the center of every
wide torso. This could read as a tie or zipper despite no such source cue.

Wide torso front/back faces now place the two material accents just inside the
side contours, preserving the quiet center. Near-black broad cloth uses a
restrained ramp; narrow sleeve/leg faces retain their existing material rule.
Exact source-fill, inset panel, print, neckline, seam and alpha guards remain.
No source ID, photo-specific correction, observed category or model output is
changed by this design rule.

Three authored black/cream/blue sweater units produce distinct valid default
PNGs, each with 48 intentional torso-only RGB changes and no alpha change.
These units are not live photo observations. Historical material projection
keeps prior golden files immutable and verifies the exact old pixels while
separately bounding current hair and torso changes. Frozen twelve retain craft
and geometry; calibrated five are included. It is incorrect to call the actual
new atlas diff zero.

Current verification and before/after artifacts are recorded in
`evaluation-artifacts/quiet-torso-release-check-20261008-001/REPORT.md`.
This entry is local implementation evidence, not a deployment statement or a
fresh provider end-to-end success claim. Earlier version identities in this
guide describe their historical release only.

### Categorical singleton upper catch (2026-10-10)

Saved C retains categorical normal openness and medium footprint, but the
five-cell hair-framed window reduces its symmetric eyes to singleton irises.
The paired upper catch now gives that case an explicit authored presentation:
one light cell immediately above each existing source-colored iris. It uses
the selected family's existing iris-glint palette, not reference bitmap pixels.
Different source pigments and positions therefore remain different.

This is not a measured sclera/aperture observation and does not rewrite the
canonical measurements, layout, plan or iris coordinates. It requires trusted
categorical normal/medium selection, a level singleton pair, no accepted eye
geometry/protection/asymmetry, no glasses and two available skin cells. Source
hairline, landmarks, beard/material protection and immutable source outer-alpha
all gate the complete pair. A single collision retains the source presentation.

Composition records `eyePresentation`; selection independently reconstructs
it from the source/template and verifies both actual paint and visibility.
Rewriting the diagnostic cannot authorize a changed catch color or an occluding
overlay. The older singleton-color-only rule still applies when this additional
presentation is ineligible. Historical study and live artifacts remain intact.

This is local implementation evidence, not a fresh live or deployment claim.

### Explicit knee distressing (2026-10-10)

Saved C primary evidence explicitly names ripped distressing on viewer-right
knee. The original photo shows that cue; the former OutfitPlan omitted it and
rendered two plain denim legs. This is a plan-stage loss, not a reason to change
the provider prompt or invent the expected appearance in a renderer fixture.

Visible observed jeans can now carry `lower.kneeDistressing`: anatomical part
ownership, evidence, and a separate explicit-skin flag. Viewer sides invert;
unqualified left/right are wearer sides, and both knees require explicit pair
evidence. Negated, uncertain, printed, repaired, hidden, unlocated, conflicting,
short/legwear-covered or non-denim evidence does not activate it. Coordinated
construction after the denim noun stays attached until the next garment.

The glyph is authored simplification, not measured rip geometry: six front
interior cells at the knee with two desaturated denim thread rows and a darker
denim gap. Skin appears only when the observation explicitly says it is visible
through the tear. No opposite-leg guess, alpha hole, UV-edge change or extra
outer shell is introduced. Existing independent garment-foundation validation
rejects erasure of the new cue. Stored C replay changes exactly six pixels;
historical PNGs and annotations remain unchanged. This is offline evidence,
not proof of a fresh provider observation or deployed output.

Observed attached sleeve cuffs retain a separate material color on an already
planned pair of long sleeves. One visible, unambiguous upper garment and an
explicit solid plural cuff description are required; detached wrist cuffs,
lower-garment cuffs, layering, uncertainty and one-sided/multicolor evidence
do not activate this binding. Only the existing terminal sleeve row and cuff
fold are recolored. Shoulder caps, sleeve length, skin rows and alpha remain
unchanged. Historical plans without cuff material keep their previous paint.
The D020 same-run offline replay changes 56 cuff pixels and nothing else;
this is not a new provider observation or fresh live delivery verification.

### Narrow loose-hair face boundary (2026-10-11)

Observed categorical face-framing straight/wavy hair with non-full volume now
uses a one-column front side rail for medium/long hair as well as short hair.
The former unconditional two-column long-hair rail joined source-colored iris
pixels to the side hair. The correction belongs to mask planning, not an iris
color override or a post-render skin patch. Crown rows, side/back mass, side
asymmetry, endpoints and connected body-drape roots remain source-driven.

Measured head silhouettes, actual coverings, clipped/unknown hair, tied hair,
curly/coily volume and broad/ordinary non-framing hair keep their existing
branches. Face measurements and landmark plans are not edited. Ownership,
paint and craft checks remain active. A saved D020 plan transplant verifies
the current structure/ownership/render chain; it is not a fresh E2E result.
Two earlier pixel-paint studies remain explicitly unadopted and rejected by
the production validator. Full product quality still requires broader visual
and fresh production-equivalent verification.

### Attached chest graphic versus depicted garment (2026-10-11)

A visible standalone pullover with a positively attached, named-color chest
graphic remains a pullover. The word `graphic` must not by itself disable the
existing strongly-implied long-sleeve construction. Explicit sleeve lengths
still win. A garment depicted in a picture, uncertain/hidden evidence, other
layers, accessory-owned motifs and another garment's graphic do not establish
this relation.

An explicitly named cross on the center chest uses a compact connected base
ink symbol, source-colored and confined to the torso front. It is not a copied
reference bitmap, a raised panel or permission to stamp sleeves/back. Generic
graphic depth pixels use the pattern's own ink rather than the garment accent.
No observation or provider contract was changed. F002's preserved live trace
establishes the missing plan connection; the subsequent saved-plan replay is
offline evidence, not a new production PNG or a full Goal completion claim.

### Worn covering versus hooded clothing (2026-10-11)

A hoodie is a garment, not proof that the hood is worn. Covered-compatible
hair candidates require positive worn hood or beanie evidence, not the
hoodie/hooded noun alone. Explicit hood-down, uncertain, carried or depicted
headwear does not qualify. This gate changes no headwear ownership, observed
hair length/opening, color, mask, landmark or outfit plan.

The immutable F006 trace had hat=none and covering=false but selected the
covered grammar solely from clothing. Removing that candidate restored the
existing short staggered grammar: 70 head-only pixel differences, 18 selective
outer hair cells rather than zero, craft PASS. Current offline selection
matches that single-variable ablation. The central forehead opening remains
source-category-driven; this is not evidence that every hair defect is solved.
Historical live PNGs remain unchanged; no fresh live verification is implied.

F007 later exercised the worn-covering gate on a fresh default-V3 response:
hoodie-only clothing no longer adds the covered family. The actual selected
medium-layered grammar has 38 outer hair cells. Its jaw-length observation
differs from F006, so the two live images are not a controlled hair ablation.

### Matte attached chest ink (2026-10-11)

F007 explicitly observed a matte black cross graphic, but the bounded positive
attachment parser stopped at `matte`, producing a generic white chest graphic.
The optional finish word now preserves the already named ink and symbol; it
does not establish color, shape, garment ownership or visibility by itself.
All existing uncertainty, layer, accessory and chest-placement guards remain.
An exact saved-plan offline isolation changes 14 chest base/overlay pixels,
with no face/hair/sleeve/lower-body changes. This is not a new live result or
a claim that the observed short sleeves and forehead appearance are resolved.

F008 fresh live evidence later delivered the dark `graphic of a cross` and
long strongly-implied pullover sleeves into an exact-replayed 64×64 PNG.
Its wording omitted `matte`, so this does not independently exercise the new
modifier branch. The provider's short-sleeve category is retained as a conflict.
The same run exposed a remaining color-binding gap: observed `The hair is a
medium ash-gray color` survives normalization, but injected hair remains the
dark-brown categorical fallback. Repair the earliest bounded material binding,
not the renderer or the historical live PNG. F008 is progress, not Goal completion.

### Complete material-color predicates (2026-10-11)

A complete observed clause such as `The hair is a medium ash-gray color` binds
the existing gray palette to hair. This is a material-subject assertion, not
permission to scan arbitrary accessory/garment prose for a preferred color.
Clause boundaries, uncertainty, negation and contradictory material claims stay
conservative. F008 offline replay restores only the color parameter: 280 head
pixels, zero body/alpha changes, unchanged plans and 38 outer hair cells.
No fresh provider success or complete hairstyle-quality claim follows from this
offline result. Historical F002 palette replay explicitly uses its pre-relief
crown contract, while current crown and F008 topology remain independently tested.

### Dense unparted fringe opening (2026-10-11)

F009 preserves an explicit central opening, not a root part: primary/normalized/
injected `fringeOpening=center`, `hairPart=none`, dense straight eye-length fringe.
The old semantic layout and structure discarded density and always split both
central columns, unlike the existing painter's bounded dense-straight opening.
The semantic fallback now retains a one-column opening for dense straight brow/
eye-length fringe without a root part. Sparse/balanced, curtain, explicit part,
short fringe and measured hairlines keep their existing contracts. This is pixel
grammar, not invented source coordinates or relabeling the provider observation.
The authored before/after unit changes four head pixels and zero body pixels;
non-fringe facial instructions remain exact. It does not reconstruct F009's
omitted analysis fields or claim fresh live delivery. F009 itself remains immutable.

### Ambiguous endpoint prose (2026-10-11)

F010 records structured `overallHairLength=jaw` becoming `shoulder` because
`jaw/shoulder length` accidentally matched a single endpoint recovery rule.
Alternatives/ranges across distinct endpoint categories are now excluded from
prose endpoint recovery. Equivalent aliases such as jaw/chin and independent
explicit endpoint statements remain supported. Preserve structured evidence when
prose does not resolve an endpoint; do not pick the longest alternative.
The authored complete replay changes shoulder/long-straight to jaw/medium-layered
with unchanged facial/outfit plans and palette. This is not reconstruction of
omitted live fields, proof of new live delivery, or completion of the quality Goal.

### Local grooming is not overall length (2026-10-11)

F011's accepted primary says `overallHairLength=jaw` and `tapered around ears,
falling to nape`; endpoint recovery wrongly used `around ears` as overall length.
Exclude only local tapered/trimmed/faded ear-grooming spans from that recovery.
Keep explicit ear-length endpoints and independent longer endpoints authoritative.
The complete authored replay preserves face/outfit plans and palette; it does not
reconstruct omitted live context. F011 itself is immutable and proves pre-fix
ear/short-family delivery, not delivery of this later offline repair. Its observed
tonal cross emblem also disappears before the outfit pattern plan and remains a
separate evidence-backed offline boundary. No additional live sampling is justified
merely by wishing for a better provider response.

### Tonal attached emblems (2026-10-11)

F011 explicitly preserves a `tonal dark cross emblem printed/embossed on the
center chest` in primary and normalized observation, but loses it before the
outfit pattern plan. The existing visible standalone garment attachment parser
now accepts emblem and tonal/application wording while still requiring explicit
ink, shape and chest placement. Tonal is not a fallback color; print/emboss
ambiguity does not create raised garment topology. Accessory, hidden, ambiguous
shape and wrong-surface guards remain. Exact F011 saved-plan pattern transfer
restores 14 cross pixels and removes 10 plain-front folds under the existing
printed-surface rule; every unrelated surface and alpha remains exact. No fresh
live delivery or broader face/hair quality claim follows from that offline replay.

### Reference A first live baseline and part-direction scope (2026-10-11)

A001 returned a valid production-equivalent PNG through eligible Gemini 429 to
Gemma fallback. Its invalid localization correctly prevented geometry dispatch.
The stored primary's center part became left because the old proximity regex
borrowed `viewer-left` from the neighboring purple-bow observation. Direction
recovery now requires a direct grammatical attachment to the part. This is not
a rule for A or for purple bows, and does not fabricate missed front hair length.

Keep these separate, unfinished quality boundaries visible:
- Front locks were described at jawline despite overall chest length. Current
  front-drape authorization cannot borrow the separate overall endpoint.
- Supported rear completion is dropped as a whole by accessory collision. The
  same saved plan without accessories proves that boundary, but removing its
  real belt is not an acceptable repair.
- Four pastel colors survive observed prose, while the final upper plan has one
  color block. Audit the color mapping before changing its representation; the
  observed gradient does not authorize target-image checker blocks.

The immutable live PNG predates this part-scope fix. Offline exact saved-plan
replay validates evidence recovery, not delivery of the new normalizer. No Goal
completion or reference-level quality claim is supported by this baseline.

### Accessory occlusion must not erase a connected hair mass (2026-10-11)

The A001 executable plan reproduces a whole rear curtain being discarded
because four endpoint cells overlap the observed belt. Preserve accessory
ownership cell-by-cell, then retain only four-neighbor hair components reached
from actual head roots. Do not paint detached fragments below a full occluding
band, fabricate a shorter observed endpoint, or remove the belt. Original length
and shading stay intact; accessory/disconnected losses have separate diagnostics.

The exact saved-plan replay restores 40 body-back pixels with zero unrelated
changes and unchanged source plans. Chest/waist belt tests, diagonal strap
occlusion, fully blocked roots and adversarial erased/recolored hair are covered.
The historical PNG is replayed with a test-only historical collision policy,
never overwritten. Existing 84 frozen gallery PNGs remain byte-identical.
This confirms offline composition repair, not fresh provider delivery. Front
lock observation and the pastel garment palette remain separate open issues.

### Observed garment gradients are not plain cloth or checker blocks (2026-10-11)

A001 retained the same complete upper-garment color clause in primary and
normalized observation. `buildOutfitPlan` then selected `none`, losing yellow,
purple and light blue. This is a normalized-observation → plan loss, separate
from the provider describing the source's block pattern as a gradient.

An explicitly observed whole-cloth gradient now keeps its complete named palette
in an internal stepped-gradient plan. Unknown/partial palettes, accessory/local
ownership, hidden garments and prompt-only evidence do not activate it. The
existing pastel ramp is shared with block cloth without changing its output.
An absent gradient direction stays absent in evidence; vertical list-order
placement is a deterministic design default, not photographic localization.
Named colors are rendered within the actual cloth interior before structural
neckline/hem/cuff/accessory ownership. No checker topology or extra outer shell
is inferred from the colors.

A001 saved-plan pattern-only replay changes 172 upper-cloth pixels, retains all
four named colors and leaves every unrelated pixel exact. The prior rear-hair
repair is held identical on both sides. Raw live evidence is immutable; this
is not a reconstructed full primary analysis or a new live delivery claim.
The provider's missed block topology/front hair length remain unresolved.

### Fresh A002 delivery and gradient construction wording (2026-10-11)

A002 returned a valid production-equivalent PNG. The same-run `center` part
survived normalization, and the exact plan/PNG replay retained 40 rooted rear
hair cells while excluding four belt-owned cells. These repairs now have live
delivery evidence, distinct from source-observation accuracy.

Its observed `puff-sleeve top with a pastel gradient pattern of purple, pink,
and yellow` remained unchanged in normalized analysis but selected plain cloth.
Two independent parser boundaries were reproduced: the optional `pattern` noun
and a directly garment-attached `puff-sleeve` modifier. Support these bounded
forms without authorizing gradients local to sleeves, logos or accessories.
The saved-plan palette-only repair changes 196 upper-cloth pixels with zero
unrelated changes. It is offline evidence, not a second live result. All 84
existing frozen gallery PNGs remain byte-identical. No block topology, omitted
front-lock length or exposed midriff is invented from this gradient clause.

### A003: explicit palette notation is independent of cloth ownership (2026-10-11)

A003 again preserved its palette in primary and normalized evidence, now as
`pastel rainbow color gradient (purple, blue, pink, yellow) and ruffled sleeves`.
Do not interpret repeated unsupported prose forms as proof that observation
must be discarded. The bounded gradient parser now accepts the same complete
named-color list in parentheses as after `of`, with optional color/colour and
rainbow descriptors. `rainbow` without an explicit valid list supplies no colors.
A terminal `and ruffled/puff sleeves` construction supplies no sleeve pigment;
local sleeve, logo, unknown-color and incomplete lists remain rejected.

Exact saved-plan replay restores the four named colors in 154 upper-cloth pixels
without changing hair or unrelated pixels. A003's actual live PNG already has
20 front and 40 rear hair cells, linked to observed shoulder drape. The new
palette syntax repair remains offline evidence. All 84 frozen gallery PNGs are
unchanged. Source block topology and sleeve-specific pigmentation must still be
distinguished from a global gradient observation; never manufacture them from
the reference identity.

### G002: observed dyed hair must reach the material parameter (2026-10-11)

G002's accepted primary and normalized evidence both retained `long, wavy,
dyed-pink hair`, but the injected hair material was dark brown. The bounded
observed-hair material resolver supported natural colors but omitted the four
dyed colors already present in the existing palette. It now recognizes pink,
blue, purple and green only under the existing hair-noun/ownership, uncertainty,
negation and single-material restrictions. Mixed pigments stay unresolved;
clothing and accessory colors cannot supply hair pigment.

The saved-plan counterfactual changes only the hair-color input, not the stored
primary or plans. Its 396 RGB changes are confined to hair/head material; no
unrelated body pixel changes. Iris RGBA remains exact. This is NOT a claim of
perfectly independent material ownership: 37 changed head cells lie outside
the compositor hair diagnostic and one top-overlay accessory cell changes
alpha. The first observed divergence is already present after baseline head
composition/shading, before seam reconciliation. Existing material-sensitive
head/accessory coupling remains an explicit unresolved boundary.

The offline pink result is visibly improved, valid and deterministic, but is
not a fresh live delivery result. Short sleeves, accessory scale/ownership and
front hair drape remain separate evidence questions. All 84 frozen gallery
PNGs remain unchanged; reference craft passes 12/12 and the five calibrated
cases remain unchanged. Do not infer full source correctness from those counts.

### G002: lower plaid pigment belongs to the skirt (2026-10-11)

The accepted primary and normalized clothing observation names a brown-and-tan
plaid skirt, while the saved lower pattern inherited the white shirt accent.
Reuse the existing garment-scoped palette resolver for visible lower plaid.
Hidden/prompt-only/uncertain and accessory-local colors keep their previous
fallback; no new colors or inferred source details are added. Saved-plan replay
restores tan in four skirt pixels with zero unrelated or alpha changes and
unchanged craft/UV validity. The 84 frozen gallery PNGs remain byte-identical.
This narrow color repair does not establish correct sleeves, legwear, accessory
scale or complete outfit likeness; those remain separate observed boundaries.
