/**
 * PNG 저장: 토스 앱 안에서는 saveBase64Data(기기 저장),
 * 브라우저에서는 <a download> 폴백.
 */

import { saveBase64Data } from "@apps-in-toss/web-framework";

export async function savePng(dataUrl: string, fileName: string): Promise<void> {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  try {
    await saveBase64Data({
      data: base64,
      fileName,
      mimeType: "image/png",
    });
    return;
  } catch {
    // 토스 앱 밖(브라우저)이거나 저장 실패 — 링크 다운로드로 폴백
  }
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
