# Public garment finish

The outfit plan still owns the photographed cut, trim, palette, motifs and conservative completion for unseen clothing. The public plan reads long skirt/dress length only from the relevant garment clause, not a neighbouring garment's sleeves. The texture pass only adds lighting to authored fabric, using restrained light/dark groups rather than noise, following the [Blockbench Minecraft texturing guide](https://blockbench.net/wiki/guides/minecraft-style-guide/).

- Torso: broad shoulder highlight with a quiet chest; an existing overlap/cuff/hem retains priority. Never add a zipper, tie or pocket just to create contrast.
- Legs: the denim wash bends across the thigh/knee. Skirts and dresses use softer extended folds; tailored and stretch fabrics use shorter or lower-contrast shapes.
- Ownership: trace the last base-layer writer in the actual outfit renderer. A pattern can have exactly the same RGB as the cloth and still be protected. Existing decorative relief, shoe texels, exposed skin, UV edges, hair drape and scarves are excluded. The pass does not add or remove outer-layer pixels.
- Runtime: applied after the validated reference renderer, identically for the public web/app path. Older diagnostic renders remain replayable without the `garmentFinish` policy. No model or provider call is added.
- Tall legwear: a visually confirmed sock or thigh-high on a separate short hem owns a bounded run up from the shoes, with skin between hem and cuff when there is room. Ankle socks, continuous tights and unseen lower-body completions retain their existing policies.

From `workers`, run `npm test -- test/publicClothBench.test.ts`. Set `PUBLIC_CLOTH_BENCH_DIR` to keep the 216 skin PNGs, visual comparisons and HTML review. The combinations are authored, synthetic analysis inputs rather than real photos; the test covers the garment renderer, byte preservation, structural diversity and PNG round-trip. The saved-analysis integration suite separately exercises the public generation endpoint.
