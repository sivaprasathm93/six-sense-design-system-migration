'use strict';

/**
 * Single source of truth for everything the migration is allowed to rewrite.
 * Widening the migration means editing a map here, not a transform.
 */

const OLD_PACKAGE = '@old/ui';
const NEW_PACKAGE = '@acme/ds';

/** Legacy `variant` values -> new `intent` values. */
const VARIANT_MAP = { primary: 'brand', secondary: 'neutral', danger: 'critical' };

/** Legacy `size` values -> new `size` values. */
const SIZE_MAP = { sm: 'small', md: 'medium', lg: 'large' };

/** Legacy Button prop names -> new Button prop names. */
const PROP_MAP = { variant: 'intent', block: 'fullWidth' };

/**
 * CSS properties whose values may carry a color. Used for CSS declarations and,
 * in camelCase form, for inline style object keys in TS/JS.
 */
const COLOR_PROPERTIES = new Set([
  'accent-color', 'background', 'background-color', 'background-image', 'border', 'border-color',
  'border-bottom', 'border-bottom-color', 'border-left', 'border-left-color',
  'border-image', 'border-image-source', 'border-right', 'border-right-color',
  'border-top', 'border-top-color', 'box-shadow', 'caret-color', 'color',
  'column-rule', 'column-rule-color', 'filter', 'fill', 'flood-color',
  'lighting-color', 'outline', 'outline-color', 'stop-color', 'stroke',
  'text-decoration-color', 'text-shadow', 'text-stroke', '-webkit-text-stroke',
]);

/** Variable names that make a bare hex string a color rather than an identifier. */
const COLOR_VARIABLE_PATTERN = /(?:colors?|border|background|fill|stroke)$/i;

/** Files the migration and the color lint consider source. */
const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?|css)$/i;

/**
 * Generated output is never source: the token layer is derived from
 * `primitive-tokens.json`, so migrating or linting its hex values would be
 * circular (and would flag the very declarations that make tokens resolve).
 */
const GENERATED_FILE_PATTERN = /\.generated\.(?:css|ts|tsx|js|jsx)$/i;

/** CSS custom-property declarations, e.g. `--brand: #1a73e8`. */
const CUSTOM_PROPERTY_PATTERN = /^--[\w-]+$/;

/**
 * Prefix of the review comments the migration leaves in the code. Owned by the
 * migration, so `grep -rn "TODO(ds-migration)"` is the open-debt list and a
 * later stage can find the markers an earlier one wrote.
 */
const TODO_MARKER = 'TODO(ds-migration)';

const DEFAULTS = {
  target: 'apps/web-dashboard/src',
  tokens: 'tokens/primitive-tokens.json',
  report: 'report/REPORT.md',
  exceptions: 'codemods/color-exceptions.json',
  tokenLayer: 'apps/web-dashboard/src/styles/tokens.generated.css',
};

module.exports = {
  COLOR_PROPERTIES,
  COLOR_VARIABLE_PATTERN,
  CUSTOM_PROPERTY_PATTERN,
  DEFAULTS,
  GENERATED_FILE_PATTERN,
  NEW_PACKAGE,
  OLD_PACKAGE,
  PROP_MAP,
  SIZE_MAP,
  SOURCE_FILE_PATTERN,
  TODO_MARKER,
  VARIANT_MAP,
};
