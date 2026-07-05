/**
 * Sanitization for untrusted text that reaches a user-visible sink.
 *
 * On-chain fields (the 64-byte task description, an agent's registered endpoint)
 * are attacker-controlled and routinely hold binary, control bytes, or the
 * U+FFFD replacement char. Rendered raw they show up as mojibake on the task
 * board and in metadata. These helpers gate such values to legible text or a
 * safe fallback.
 *
 * NOTE: kept in behavioral parity with agenc.ag's `apps/web/lib/text.ts`
 * (this repo was extracted from that codebase's `services/indexer`).
 */

// Unicode control chars (Cc = C0/C1, U+0000-001F and U+007F-009F) plus the
// U+FFFD replacement char a lenient UTF-8 decode emits for invalid input.
const UNPRINTABLE = /[\p{Cc}\uFFFD]/u;

// What counts as a printable glyph in legible text: letters, numbers,
// punctuation, spaces, symbols (incl. emoji), and combining marks.
const PRINTABLE = /[\p{L}\p{N}\p{P}\p{Zs}\p{S}\p{M}]/u;

/** Strip NUL padding, collapse runs of whitespace to single spaces, and trim. */
export function cleanWhitespace(text: string): string {
  return text.replace(/\0+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * True when `text` reads as a real title rather than decoded binary: it has at
 * least one letter/number, carries no control or replacement chars, and is
 * overwhelmingly printable (>= 80% of code points). Callers fall back to a hex
 * preview when this is false.
 */
export function isLegibleText(text: string): boolean {
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return false;
  if (UNPRINTABLE.test(text)) return false;
  const chars = [...text];
  const printable = chars.filter((ch) => PRINTABLE.test(ch)).length;
  return printable / chars.length >= 0.8;
}

/**
 * Decode a fixed-size, NUL-padded on-chain text field to a legible string, or
 * null when the bytes are not legible UTF-8 text (binary, control bytes, or
 * mojibake). Decoding is fatal so invalid UTF-8 - what a binary hash written
 * into the description field almost always is - rejects instead of silently
 * becoming U+FFFD. Callers render a hex preview / 'Unavailable' on null.
 */
export function decodeOnChainText(bytes: Uint8Array): string | null {
  let decoded: string;
  try {
    decoded = cleanWhitespace(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  return isLegibleText(decoded) ? decoded : null;
}

/**
 * Normalize untrusted display text (spec-metadata fields) by removing control,
 * format, private-use, surrogate, and replacement characters, then collapsing
 * whitespace. Unlike `isLegibleText` (which gates), this keeps the legible
 * remainder so a mostly-fine string is cleaned rather than rejected.
 */
export function cleanDisplayText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}�]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
