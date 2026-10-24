/** Browser-native downloads; no app bridge or advertising SDK. */
export async function savePng(dataUrl: string, fileName: string): Promise<void> {
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Expected a PNG image.");
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
