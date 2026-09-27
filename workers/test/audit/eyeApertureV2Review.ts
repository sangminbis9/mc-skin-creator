/** Local-only visualization of persisted, validated numeric evidence. Never used as provider input. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { readLatestAuditCheckpoint } from "../primaryAuditRunnerSupport";
import { APERTURE_CROP_PATHS } from "./eyeAperturePilot";
import { APERTURE_INPUTS } from "./eyeAperturePilotContract";
import { APERTURE_V2_LIVE_ROOT, verifyApertureV2Recovery, type ApertureV2State } from "./eyeApertureV2Live";

export async function recoverApertureV2Overlays() {
  const root = APERTURE_V2_LIVE_ROOT, record = await readLatestAuditCheckpoint(path.join(root, "summary.json"));
  const snapshot = record?.snapshot as { apertureV2?: ApertureV2State; classification?: string } | undefined;
  const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
  if (!record || !snapshot?.apertureV2 || hash(JSON.stringify(record.snapshot)) !== record.snapshotSha256)
    throw new Error("v2_review_checkpoint_invalid");
  const state = snapshot.apertureV2;
  if (!state.diskRecovery) throw new Error("v2_review_recovery_not_confirmed");
  verifyApertureV2Recovery(state, structuredClone(state));
  const destination = path.join(root, "local-review"); fs.mkdirSync(destination);
  const files: string[] = [];
  for (const slot of state.slots) {
    if (!slot.accepted || !slot.derived?.measurementAvailable) continue;
    const bytes = fs.readFileSync(APERTURE_CROP_PATHS[slot.input]);
    if (hash(bytes) !== APERTURE_INPUTS[slot.input].sha256) throw new Error("v2_overlay_crop_changed");
    const w = slot.dimensions.widthPx, h = slot.dimensions.heightPx;
    const save = (name: string, b: Uint8Array) => { fs.writeFileSync(path.join(destination, name), b, { flag: "wx" }); files.push(name); };
    save(`${slot.id}-source.png`, bytes);
    const line = (a: { x: number; y: number }, b: { x: number; y: number }, color: string) =>
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="0.65"/>`;
    const dot = (p: { x: number; y: number }, color: string) => `<circle cx="${p.x}" cy="${p.y}" r="1.2" fill="none" stroke="${color}" stroke-width="0.7"/>`;
    const drawing = (["left", "right"] as const).map(side => {
      const m = slot.derived![side].measurement; if (!m) return "";
      const half = m.chordWidthPx / 2, mid = m.midpointPx;
      return line(m.outerPx, m.innerPx, "yellow")
        + line({ x: mid.x - half * m.normal.x, y: mid.y - half * m.normal.y }, { x: mid.x + half * m.normal.x, y: mid.y + half * m.normal.y }, "#808080")
        + line(m.upperPx, m.lowerPx, "white") + dot(mid, "lime") + dot(m.outerPx, "red") + dot(m.innerPx, "red")
        + dot(m.upperPx, "cyan") + dot(m.lowerPx, "magenta");
    }).join("");
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${drawing}</svg>`);
    const native = await sharp(bytes).composite([{ input: svg }]).png().toBuffer();
    save(`${slot.id}-native.png`, native);
    save(`${slot.id}-4x.png`, await sharp(native).resize(w * 4, h * 4, { kernel: "nearest" }).png().toBuffer());
    save(`${slot.id}-source-4x.png`, await sharp(bytes).resize(w * 4, h * 4, { kernel: "nearest" }).png().toBuffer());
  }
  const result = { checkpointSequence: record.sequence, checkpointSha256: record.snapshotSha256,
    classification: snapshot.classification, files, quantitativeLandmarkAccuracy: "NOT_MEASURED",
    repeatability: "NOT_TESTED", populationGeneralization: "NOT_TESTED",
    limitation: "Model-assisted qualitative review, not human ground truth. NORMAL eyeliner makes exact lid boundaries ambiguous. Same-section alignment is constructed, not accuracy evidence.",
    legend: { corners: "red", chord: "yellow", midpoint: "lime", normal: "gray", upper: "cyan", lower: "magenta", gap: "white" } };
  fs.writeFileSync(path.join(destination, "overlay-index.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  return result;
}
