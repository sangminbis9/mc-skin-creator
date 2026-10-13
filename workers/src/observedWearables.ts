/** Extra wearable cues stay scoped to direct observations and known sides. */
import type { PhotoAnalysis } from "./analysis";
import type { OutfitAccessoryPlan, OutfitAccessoryKind } from "./outfitIdentity";
const palette: Record<string, string> = { black:"#242329", white:"#e8e5e1", silver:"#b0b6c2", gray:"#74737d", gold:"#caa44b", red:"#b23440", blue:"#567cbb", pink:"#da95b1", brown:"#6b4733" };
export function observedWearables(a: PhotoAnalysis): OutfitAccessoryPlan[] {
  const result: OutfitAccessoryPlan[] = [];
  for (const sentence of [a.observed.accessories, a.observed.clothing].flatMap(s => s.toLowerCase().split(/[.;!?]|\bbut\b/))) {
    if (/\b(?:no|not|without|hidden|unknown|uncertain|possibly|maybe|might|could|print|printed|pattern|logo)\b/.test(sentence)) continue;
    for (const clause of sentence.split(/,|\band\b/)) {
      const rules: Array<[OutfitAccessoryKind, RegExp]> = [["choker", /\bchoker\b/], ["brooch", /\b(?:brooch|lapel pin)\b/],
        ["watch", /\b(?:wristwatch|wrist watch|watch)\b/], ["bracelet", /\b(?:bracelet|wristband)\b/], ["waist_chain", /\b(?:waist|belt|wallet)[- ]chain\b/]];
      const matches = rules.filter(([, re]) => re.test(clause));
      if (matches.length !== 1) continue;
      const kind = matches[0][0];
      if (kind === "waist_chain" ? !a.visibleRegions.lowerBody : !a.visibleRegions.upperBody) continue;
      const left = /\bviewer(?:'s)?[- ]left\b/.test(clause), right = /\bviewer(?:'s)?[- ]right\b/.test(clause);
      const side = left && !right ? "left" : right && !left ? "right" : kind === "choker" || ["watch", "bracelet"].includes(kind) && /\bboth\b/.test(clause) ? "center" : undefined;
      if (!side || result.some(p => p.kind === kind && p.side === side)) continue;
      const noun = matches[0][1].exec(clause)!.index;
      const named = [...clause.matchAll(/\b(black|white|silver|gray|gold|red|blue|pink|brown)\b/g)]
        .filter(m => Math.abs(m.index - noun) <= 28).sort((a, b) => Math.abs(a.index - noun) - Math.abs(b.index - noun));
      const name = named[0]?.[1] ?? "gray";
      result.push({ kind, side, color:palette[name], source:"observed", evidence:clause.trim() });
    }
  }
  return result.slice(0, 5);
}
