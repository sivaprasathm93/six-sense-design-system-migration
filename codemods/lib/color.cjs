'use strict';

const fs = require('node:fs');

/**
 * Color primitives: lexing hex literals out of text and loading the token map.
 * No knowledge of files or transforms. Matching is exact: a color with no token
 * is reported as unmatched, never approximated to a near one.
 */

// --- Hex literals ----------------------------------------------------------

/** Digit counts of a valid hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */
const HEX_LENGTHS = [3, 4, 6, 8];

/** Digit counts that carry an alpha channel, which has no primitive token. */
const ALPHA_HEX_LENGTHS = [4, 8];

/**
 * Expands a 3- or 6-digit hex to lowercase 6-digit form.
 *
 * @returns {string | null} `null` for anything else, including alpha hexes.
 */
function normalizeHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((part) => part + part).join('') : digits}`;
}

/** True when the literal carries an alpha channel. */
function hasAlphaChannel(value) {
  return ALPHA_HEX_LENGTHS.includes(value.length - 1);
}

/**
 * Reads a hex color starting at `index`.
 *
 * @returns {{ start: number, end: number, value: string } | null}
 */
function parseHexAt(text, index) {
  if (text[index] !== '#') return null;
  let end = index + 1;
  while (end < text.length && /[0-9a-f]/i.test(text[end])) end += 1;
  if (!HEX_LENGTHS.includes(end - index - 1)) return null;
  return { start: index, end, value: text.slice(index, end) };
}

/** Advances past a block comment starting at `index`. */
function skipComment(value, index) {
  const end = value.indexOf('*/', index + 2);
  return end < 0 ? value.length : end + 2;
}

/** Advances past a quoted string starting at `index`. */
function skipQuoted(value, index) {
  const quote = value[index];
  let cursor = index + 1;
  while (cursor < value.length) {
    if (value[cursor] === '\\') cursor += 2;
    else if (value[cursor++] === quote) break;
  }
  return cursor;
}

/** Advances past a `url(...)` token starting at `index`, nesting and quotes included. */
function skipUrl(value, index) {
  let depth = 0;
  let quote = null;
  let cursor = index;
  for (; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (quote) {
      if (char === '\\') cursor += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')' && --depth === 0) {
      return cursor + 1;
    }
  }
  return cursor;
}

/**
 * Finds every hex color in a value.
 *
 * @param {string} value
 * @param {boolean} skipCssSyntax skip comments, quoted strings, and `url(...)`
 *   so a hex inside a comment or an asset path is never rewritten. Off for
 *   TS/JS string literals, whose contents are already the whole value.
 * @returns {{ start: number, end: number, value: string }[]} offsets relative to `value`.
 */
function collectHexes(value, skipCssSyntax) {
  const matches = [];
  let index = 0;
  while (index < value.length) {
    if (skipCssSyntax) {
      if (value.startsWith('/*', index)) {
        index = skipComment(value, index);
        continue;
      }
      if (value[index] === '"' || value[index] === "'") {
        index = skipQuoted(value, index);
        continue;
      }
      if (/^url\s*\(/i.test(value.slice(index))) {
        index = skipUrl(value, index);
        continue;
      }
    }
    if (value[index] === '#') {
      const candidate = parseHexAt(value, index);
      if (candidate) {
        matches.push(candidate);
        index = candidate.end;
        continue;
      }
    }
    index += 1;
  }
  return matches;
}

// --- Token map -------------------------------------------------------------

/**
 * Loads the primitive token file into a lookup keyed by normalized hex.
 *
 * The token file is authoritative input: a malformed entry aborts the run
 * rather than being skipped, so a typo can never quietly narrow the migration.
 *
 * @param {string} tokenFile path to `tokens/primitive-tokens.json`.
 * @returns {Map<string, string>} normalized hex -> token name.
 */
function parseTokens(tokenFile) {
  const document = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (!document.color || typeof document.color !== 'object' || Array.isArray(document.color)) {
    throw new Error(`Expected a "color" token object in ${tokenFile}`);
  }
  const tokens = new Map();
  for (const [name, value] of Object.entries(document.color)) {
    const normalized = normalizeHex(value);
    if (!normalized) throw new Error(`Invalid color token "${name}": ${value}`);
    tokens.set(normalized, name);
  }
  return tokens;
}

/** CSS custom-property reference for a token name. */
function tokenReference(name) {
  return `var(--color-${name})`;
}

module.exports = {
  collectHexes,
  hasAlphaChannel,
  normalizeHex,
  parseHexAt,
  parseTokens,
  tokenReference,
};
