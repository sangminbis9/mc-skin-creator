/** Alternatives/ranges and local grooming are not a single overall length.
 * Remove only that span from prose used for endpoint recovery; keep independent
 * observations and original provider text untouched. Equivalent aliases stay usable.
 */
export function unambiguousHairEndpointText(text: string): string {
  return text.replace(
    /\b(?:ears?|jaw|chin|shoulders?|chest|bust|waist|hips?)(?:[-\s]+(?:length|level))?(?:\s*(?:\/|[-\s]+(?:or|to)[-\s]+|[–—])\s*(?:ears?|jaw|chin|shoulders?|chest|bust|waist|hips?)(?:[-\s]+(?:length|level))?)+\b/gi,
    span => {
      const endpoints = span.toLowerCase().match(/\b(?:ears?|jaw|chin|shoulders?|chest|bust|waist|hips?)\b/g) ?? [];
      const categories = endpoints.map(endpoint => endpoint === "chin" ? "jaw"
        : endpoint === "bust" ? "chest" : endpoint.replace(/s$/, ""));
      return new Set(categories).size > 1 ? "unspecified endpoint" : span;
    },
  ).replace(
    /\b(?:tapered|trimmed|faded)\s+(?:around|at)\s+(?:the\s+)?ears?\b/gi,
    "local ear grooming",
  );
}
