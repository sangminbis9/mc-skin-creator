/** Diagnostics only: never persist arbitrary provider objects, headers or image payloads. */
export function safeProviderMessage(value: unknown, secrets: readonly string[] = []): string | null {
  if (typeof value !== "string") return null;
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted-secret]");
  return text
    .replace(/data:[^\s,]+;base64,[a-z0-9+/=\r\n]+/gi, "[redacted-image]")
    .replace(/\b(?:AIza|AQ\.)[a-z0-9._-]{16,}/gi, "[redacted-secret]")
    .replace(/(?:authorization|x-goog-api-key|api[_-]?key)\s*[=:]\s*[^\r\n,}]+/gi, "[redacted-header]")
    .replace(/\bBearer\s+[^\s,}]+/gi, "[redacted-token]")
    .replace(/[a-z0-9+/_=-]{80,}/gi, "[redacted-payload]")
    .split("").map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("")
    .slice(0, 2000);
}
