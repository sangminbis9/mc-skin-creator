# Minecraft skin craft grammar

This project learns general construction principles from public tutorials; it
does not copy, download, trace, or redistribute any third-party skin or texture.
The renderer remains analysis-driven and produces original pixels.

## Normalized principles

- Use compact material-local ramps. Hair, skin, cloth, footwear, and accents
  each receive a small shadow/base/light family rather than unrelated RGB noise.
- Prefer connected shade bands and clusters. A highlight or shadow should read
  as one material mass across neighbouring pixels and continue over physical UV
  seams when the material continues over that edge.
- Keep highlights selective. Repeated isolated bright/dark specks are noise,
  not texture; irregularity is useful only when it forms a readable lock, fold,
  hem, curl, or accessory.
- Give hair a coherent crown-to-side-to-back flow. The renderer uses explicit
  short, medium, long, curly, coily, and bald mask families, then adapts fringe,
  part, length, and observed asymmetry.
- Use the outer layer only for physical depth or silhouette: fringe, glasses,
  collars/lapels, cuffs, hems, footwear construction, and selected accessories.
  Never fill an expanded cuboid merely to raise detail counts.
- Treat garment boundaries as construction. Sleeve ends, cuffs, waistlines,
  hems, and shoe transitions should stay at consistent heights and continue
  around the relevant faces.
- Complete hidden surfaces by extending observed materials and construction.
  A plain continuation is preferable to an unsupported motif.

## Validator correspondence

- `isolatedNoiseRatio` rejects salt-and-pepper artifacts.
- `maxLocalPaletteSize` and `meanLocalPaletteSize` bound local material ramps.
- `connectedClusterCoherence` measures readable connected masses.
- `colorEntropy` plus `edgeFrequency` identifies high-entropy model noise.
- vertical/horizontal seam metrics enforce physical continuity.
- `overlayCoverageByPart` prevents outer-layer shells while allowing a wrapped
  head covering its separately calibrated head envelope.

The broad validation envelopes come from the project's varied deterministic
regression family rather than one downloaded reference skin. They are therefore
distribution guards, not a single aesthetic style rule.

## Public references

- Luis, “Guide to Hair Shading”: layered/stripe approaches, darkest lower bands,
  and connecting darker lines into the top surface.
  <https://www.planetminecraft.com/blog/luis-guide-to-hair-shading/>
- EnderGirlSkinz, “How to shade hair”: outline, controlled stepwise shades, and
  restrained final light patches.
  <https://www.planetminecraft.com/blog/how-to-shade-hair-3968938/>
- BobbieJoe, “How to shade a Minecraft skin”: surrounding/overlapping connected
  shade regions and carrying construction across body, side, arm, and leg faces.
  <https://www.planetminecraft.com/blog/how-to-shade-a-skin-3977662/>
- mumipoka, beginner hair tutorial: define the face window and use HSL shifts
  rather than unrelated colour picks.
  <https://www.planetminecraft.com/blog/how-to-paint-and-shade-hair-simple-tutorial-for-beginners/>

These links are research citations only. No images or skin files from them are
included in the repository.
