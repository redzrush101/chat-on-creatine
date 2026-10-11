/**
 * Masks credential shapes before text reaches logs, exports or the control API. This is a last
 * line of defence; secrets must never be passed to loggers in the first place.
 */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:xox[abprs]-)[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(\/mcp\/)[A-Za-z0-9_-]{16,}/g,
  /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix: unknown) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}
