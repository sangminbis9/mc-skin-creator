/** Read image dimensions without decoding a potentially huge pixel buffer.
 * Canvas-generated derivatives carry no EXIF; public API accepts JPEG/PNG. */
export function validVisionImage(url: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || url.length > 1_500_000 || match[2].length % 4 !== 0) return false;
  try {
    const prefix = atob(match[2].slice(0, Math.min(match[2].length, 131072)));
    const bytes = Uint8Array.from(prefix, c => c.charCodeAt(0));
    let width = 0, height = 0;
    if (match[1] === "png") {
      if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return false;
      const view = new DataView(bytes.buffer); width = view.getUint32(16); height = view.getUint32(20);
    } else {
      if (bytes[0] !== 255 || bytes[1] !== 216) return false;
      for (let i = 2; i + 9 < bytes.length;) {
        if (bytes[i++] !== 255) return false;
        while (bytes[i] === 255) i++;
        const marker = bytes[i++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        const size = bytes[i] * 256 + bytes[i + 1];
        if (size < 2 || i + size > bytes.length) return false;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          height = bytes[i + 3] * 256 + bytes[i + 4]; width = bytes[i + 5] * 256 + bytes[i + 6]; break;
        }
        i += size;
      }
    }
    return width >= 1 && height >= 1 && width <= 1024 && height <= 1024;
  } catch { return false; }
}
