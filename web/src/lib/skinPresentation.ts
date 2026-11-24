/** The preference describes the avatar's finish, not the person's identity. */
export const SKIN_PRESENTATIONS = [
  { value: "source", label: "Photo-led" },
  { value: "feminine", label: "Feminine · eGirl" },
  { value: "masculine", label: "Masculine · eBoy" },
] as const;

export type SkinPresentation = typeof SKIN_PRESENTATIONS[number]["value"];

export function generationReuseKey(presentation: SkinPresentation, photoHashes: string[]): string {
  return `${presentation}:${photoHashes.join(":")}`;
}

export function isGenerationReuseKey(key: string): boolean {
  return /^(source|feminine|masculine):[a-f0-9]{64}(?::[a-f0-9]{64}){1,5}$/.test(key);
}
