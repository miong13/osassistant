/**
 * Small helpers for handling text that did not come from the user directly
 * (tool results, tool descriptions, clipboard, character packs).
 */

// Unicode "tag" characters are invisible but models can read them, so they are used
// to hide instructions in otherwise normal-looking text ("ASCII smuggling").
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu

export function stripHiddenChars(text: string): string {
  return text.replace(TAG_CHARS, '')
}

/** Wrap text in a code fence that the text itself can't close early. */
export function fence(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(Math.max(3, longestRun + 1))
  return `${ticks}\n${text}\n${ticks}`
}

/** One line, no control characters, limited length. For names shown inside the system prompt. */
export function singleLine(text: string, max: number): string {
  return stripHiddenChars(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max)
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i
]

/** True when text looks like it holds a credential, so it should not be offered to the model. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text))
}
