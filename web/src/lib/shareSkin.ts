const MESSAGE = "Make a skin that's yours with Skin Studio.";

export async function shareStudioLink(): Promise<boolean> {
  const url = `${location.origin}/`;
  try {
    if (navigator.share) await navigator.share({ title: "Skin Studio", text: MESSAGE, url });
    else await navigator.clipboard.writeText(url);
    return true;
  } catch { return false; }
}

export async function sharePreviewImage(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], "skin-studio-preview.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: MESSAGE });
      return true;
    }
    return false;
  } catch { return false; }
}
