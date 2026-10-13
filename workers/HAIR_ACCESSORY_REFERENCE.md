# Hair and accessory reference update

Reference inspection, 2026-10-13: [EGirl](https://ko.namemc.com/minecraft-skins/tag/egirl) and [EBoy](https://ko.namemc.com/minecraft-skins/tag/eboy), first-page thumbnails; detailed local inspection of [paired pink ornaments](https://ko.namemc.com/skin/7eea5c21005577f2) plus the two previously supplied atlases. This is a bounded sample, not every skin on the site. Third-party artwork is not copied into production or used as a training dataset.

Observed design guidance: low eye-line fringe, coherent broad hair locks, selective raised depth rather than an opaque outer helmet, and small high-contrast ornaments attached to the hair. Pixel art styling is not evidence that the photographed subject wore an item.

## Executable changes

- `flow_locks_v3`: deterministic physical-coordinate hair shading with a broad midtone, short reflection, root shadow and tapered ends. Straight/wavy evidence changes the flow; all twelve physical head seams use identical coordinates. Historical material policies remain available.
- `supported_profile_locks_v1`: small stepped raised temple bundles over already-owned base hair, attached to a continuous base-hair crown without requiring an outer shell. No new length, dye, part, ear occlusion or arbitrary back-view feature. Existing coverage and inner/outer budgets apply.
- `headOrnaments.ts`: exact shared ownership/paint for clips, paired bows/ribbons/flowers, headbands, headphones, earmuffs, crowns, tiaras, costume animal-ear/horn headbands, and forehead-mounted goggles. Maximum three resolved objects / 80 cells. Whole-object collision rejection protects glasses, eye windows, validated geometry and covering. Explicit viewer-side or paired evidence is required for lateral ornaments.
- `observedWearables.ts`: observed chokers, brooches/lapel pins, watches, bracelets/wristbands and waist/belt/wallet chains. Visible-region and laterality gates; no inferred jewelry on unseen limbs.
- Existing glasses, earrings, hats, headscarves, neckties/scarves, necklaces, suspenders, belts, straps, cuffs and thigh ornaments retain their existing grammar. Source-specific color/side/count is requested in individual observation clauses without changing the provider schema or call count.

## Deeper reference pass (2026-10-13)

Inspected the second EBoy/EGirl lists and four individual downloaded 64×64 atlases, each expanded into front/right/back/left/top/bottom base, outer and composite panels:

- [Pink long hair](https://ko.namemc.com/skin/215a16a5df1506c8): restrained pigment ramp, narrow dark grooves and stepped raised fringe; texture continues down side/back locks.
- [Peach short hair](https://ko.namemc.com/skin/c807a1e71f2eaeb1): brighter paired locks with staggered terminations, recessed top root rather than uniformly bright cap.
- [Penguin-themed covering](https://ko.namemc.com/skin/31eadc2ebabad00b) and [white hood/black fringe](https://ko.namemc.com/skin/eb032063161b4add): negative examples for blanket hair repainting. Covering shapes and ornaments must retain their own colors/ownership.

These are design observations from a bounded sample, not new photo measurements or a training corpus. Source PNGs and SHA-256 manifest remain local inspection artifacts; no third-party pixels are embedded in production.

The code audit found two deterministic detail losses: crown relief replaced existing lock shading with broad flat panels, and loose-hair reflections stopped after head row 7. `flowing_crown_v2` blends a staggered physical-coordinate reflection with the existing material. `continuous_locks_v4` carries restrained reflection segments/wave drift down already-authorized long locks. Neither changes hair occupancy, length, part, dye, ears, eyes, accessories or provider policy. Historical v1/v3 policies remain available. Covered, tied, undercut and measured heads retain the existing exclusion gates.

`test/referenceCrownFlow.test.ts` covers reversed crown/back seams, pigment bounds, old-policy preservation, continued nape material, same-analysis short/long replays, unchanged alpha/accessories, determinism and selector acceptance. Fresh `namemc-crown-flow-*` outputs are synthetic offline comparisons, not live-photo evidence.

Verification: 48 related offline tests passed across 10 files; the optional public-reference inspection also passed separately. TypeScript, targeted ESLint, diff whitespace checks and Worker bundle passed. Latest comparison: `evaluation-artifacts/namemc-crown-flow-g3FEuf/comparison.png`, rows short-before / short-after / long-before / long-after, columns front / three-quarter / right / back. The long fixture contains 60 real torso-hair pixels; both its footprint and accessory pixels remain unchanged. Differences are deliberately restrained on near-black hair, not a claim of human-art parity or measured live-photo improvement. No provider call, commit, push or deployment was performed.

## Remaining limits

This does not support literally every accessory. Thin rings, tiny piercings, detailed charms/logos, veils, large bags, handheld objects, capes and free-standing ears/horns cannot all be faithfully represented by the existing fixed 64×64 cuboids. Animal-ear/horn support is a small texture suggestion, not a custom mesh. Ordinary goggles over the eyes are not mapped to forehead goggles. Ambiguous position, conflicts or unsupported types are conservatively omitted; unrecognized observations remain in request-local analysis, not fabricated into a supported type.

Provider observation recall is still a quality limit. These offline checks prove deterministic propagation of supplied observations, not improved accuracy on new photographs. No extra AI/API calls, paid provider use, remote storage, deployment, or UI change is part of this update.

## Verification artifacts

Focused tests create fresh `evaluation-artifacts/namemc-hair-accessories-*` roots with 64×64 PNGs, deterministic render sheets, and JSON results. References are optional local inspection inputs, not required production assets. Run `npm exec -- vitest run test/headOrnaments.test.ts test/referenceHairDetail.test.ts test/referenceMaterialDetail.test.ts --fileParallelism=false --testTimeout=60000` from `workers`.
