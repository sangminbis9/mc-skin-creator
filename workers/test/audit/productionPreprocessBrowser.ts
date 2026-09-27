import { preparePhotoForUpload } from "../../../src/lib/imageQuality";

const status = document.getElementById("status");
const update = (message: string) => { if (status) status.textContent = message; };

async function run(): Promise<void> {
  const response = await fetch("/source.jpg", { cache: "no-store" });
  if (!response.ok) throw new Error(`local_source_http_${response.status}`);
  const source = new File([await response.blob()], "canonical-original.jpg", { type: "image/jpeg" });
  const prepared = await preparePhotoForUpload(source);
  const result = await fetch("/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prepared),
  });
  if (!result.ok) throw new Error(`local_result_http_${result.status}`);
  update("PRODUCTION_PREPROCESSING_COMPLETE");
}

void run().catch((error: unknown) => update(`FAILED: ${error instanceof Error ? error.message : "unknown"}`));
