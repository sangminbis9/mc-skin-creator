/** Local-only recovery/overlay. No provider/network imports or dispatch. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { readLatestAuditCheckpoint } from "../primaryAuditRunnerSupport";
import { APERTURE_CROP_PATHS, APERTURE_PILOT_ROOT, verifyApertureRecovery, type AperturePilotState } from "./eyeAperturePilot";
import { APERTURE_INPUTS } from "./eyeAperturePilotContract";

export function apertureRepeatability(state: AperturePilotState) {
  const sources = ([0, 1] as const).map(input => {
    const slots = state.slots.filter(slot => slot.input === input);
    const eyes = (["left", "right"] as const).map(side => {
      const a = slots[0].derived?.[side], b = slots[1].derived?.[side];
      const comparable = a?.status === "measured" && b?.status === "measured";
      return { side, states: slots.map(slot => ({ slot: slot.id, status: slot.status,
        accepted: Boolean(slot.accepted), visibility: slot.accepted?.[side].visibility ?? null,
        measured: slot.derived?.[side] ?? null })),
      repeatDifference: comparable ? {
        landmarkMovementPx: Object.fromEntries((['outerCorner', 'innerCorner', 'upperLid', 'lowerLid'] as const)
          .map(key => [key, Math.hypot(b.points![key].x - a.points![key].x, b.points![key].y - a.points![key].y)])),
        widthPx: b.widthPx! - a.widthPx!, aperturePx: b.aperturePx! - a.aperturePx!,
        absoluteRatio: Math.abs(b.ratio! - a.ratio!),
      } : null };
    });
    const means = slots.map(slot => slot.derived?.mean ?? null);
    return { input, cropSha256: APERTURE_INPUTS[input].sha256, eyes, binocularMeans: means,
      bothRepeatsMeasured: means.every(value => value !== null),
      range: means.every(value => value !== null) ? [Math.min(...means as number[]), Math.max(...means as number[])] : null };
  });
  const n = sources[0].range, o = sources[1].range;
  return { referenceMode: "QUALITATIVE_ONLY", quantitativeLandmarkAccuracy: "NOT_MEASURED",
    independentInference: "UNCONFIRMED", sources,
    sourceGapOpenMinimumMinusNormalMaximum: n && o ? o[0] - n[1] : null,
    limitation: "Two exact files, at most two repeated requests each; not independent people/eyes or population separation. Spatial review required before interpretation. No threshold chosen." };
}

export async function recoverAndOverlayAperturePilot() {
  const root = APERTURE_PILOT_ROOT;
  const recovered = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  const snapshot = recovered?.snapshot as { aperturePilot?: AperturePilotState; classification?: string } | undefined;
  if (!recovered || !snapshot?.aperturePilot) throw new Error("aperture_evidence_missing");
  const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  if (sha(JSON.stringify(recovered.snapshot)) !== recovered.snapshotSha256) throw new Error("aperture_checkpoint_hash_invalid");
  const state = snapshot.aperturePilot;
  verifyApertureRecovery(state, structuredClone(state));
  if (!state.diskRecovery) throw new Error("aperture_runner_disk_recovery_missing");
  const destination = path.join(root, "local-review");
  fs.mkdirSync(destination, { recursive: false });
  const inputBytes = APERTURE_CROP_PATHS.map((file, input) => {
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== APERTURE_INPUTS[input].sha256) throw new Error("aperture_overlay_input_changed");
    fs.writeFileSync(path.join(destination, `${input === 0 ? "NORMAL" : "OPEN"}-source.png`), bytes, { flag: "wx" });
    return bytes;
  });
  for (const slot of state.slots) {
    if (!slot.accepted || !slot.derived) continue;
    const { widthPx: w, heightPx: h } = slot.dimensions;
    const circle = (p: { x: number; y: number }, color: string) => `<circle cx="${p.x}" cy="${p.y}" r="1.2" fill="none" stroke="${color}" stroke-width="0.7"/>`;
    const line = (a: { x: number; y: number }, b: { x: number; y: number }, color: string) => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="0.6"/>`;
    const drawing = (["left", "right"] as const).map(side => {
      const eye = slot.derived![side]; if (!eye.points || !eye.apertureLine) return "";
      const p = eye.points;
      return line(p.outerCorner, p.innerCorner, "yellow") + line(eye.apertureLine.from, eye.apertureLine.to, "white")
        + circle(p.outerCorner, "red") + circle(p.innerCorner, "red") + circle(p.upperLid, "cyan") + circle(p.lowerLid, "magenta")
        + `<text x="${p.outerCorner.x}" y="${p.outerCorner.y - 5}" font-size="7" fill="yellow">${side === "left" ? "L" : "R"}</text>`;
    }).join("");
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${drawing}</svg>`);
    const overlay = await sharp(inputBytes[slot.input]).composite([{ input: svg }]).png().toBuffer();
    fs.writeFileSync(path.join(destination, `${slot.id}-native.png`), overlay, { flag: "wx" });
    const enlarged = await sharp(overlay).resize(w * 4, h * 4, { kernel: "nearest" }).png().toBuffer();
    fs.writeFileSync(path.join(destination, `${slot.id}-4x.png`), enlarged, { flag: "wx" });
  }
  const report = { checkpointSequence: recovered.sequence, checkpointSha256: recovered.snapshotSha256,
    classification: snapshot.classification, legend: { corners: "red", chord: "yellow", upperLid: "cyan", lowerLid: "magenta", apertureNormal: "white", sides: "viewer-left/right" },
    repeatability: apertureRepeatability(state) };
  fs.writeFileSync(path.join(destination, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}
