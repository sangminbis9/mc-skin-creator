# Photo-to-skin design invariant

For the public presentation, the approved NameMC reference (`namemcHeadTemplate.ts`, reference `6c13a4b6c3d74499`) owns the fixed eye coordinates, not the haircut. The base and outer masks of the hair must express the observed silhouette, fringe, root part and side profiles without covering or moving the fixed eyes. Torso hairs require supported length and placement; render the source outfit beneath them; do not infer hairstyle from gender. Do not copy the reference PNG, decorations, or outfit. Generated avatars do not draw a mouth or nose. This is a display rule: don't discard measured source cues, weaken upstream validation, or paint over observed full head coverings. Keep historical presentation replays distinct from this reference policy. Add regression coverage if changing this boundary.

The public finish does not draw eyeglasses or sunglasses, even when observed. Keep analysis and internal historical replays intact; a helmet visor is headwear, not eyewear.

Use the observed cut for the base face and stylize the surface, rather than copying each photographed strand. Explicit avatar finishes can change supported outer-layer relief and connected color groups, but cannot change the cut, part direction, base hairline or eyes. Photo-led uses cut and texture to pick a treatment, not a demographic classifier.
