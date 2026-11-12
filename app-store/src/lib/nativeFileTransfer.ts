export interface NativeFileTransfer {
  write: (path: string, base64: string) => Promise<string>;
  share: (uri: string) => Promise<void>;
  remove: (directory: string) => Promise<void>;
}

/** Keep the temporary PNG alive until the native share sheet settles. */
export async function transferPng(bridge: NativeFileTransfer, path: string, base64: string): Promise<void> {
  try {
    const uri = await bridge.write(path, base64);
    await bridge.share(uri);
  } finally {
    await bridge.remove(path.slice(0, path.lastIndexOf('/'))).catch(() => undefined);
  }
}
