export const chartColors = {
  // TODO(ds-migration) js-token-reference `chartColors`: Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute). See report/REPORT.md.
  primary: 'var(--color-blue-500)',
  danger: 'var(--color-red-500)',
  grid: 'var(--color-gray-200)',
  surface: 'var(--color-white)',
};

// TODO(ds-migration) unmatched `#FF6D00`: No primitive token exactly matches this color. Left unchanged: pick the intended token, or add one for this value, before clearing this item. See report/REPORT.md.
// TODO(ds-migration) js-token-reference `series`: Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute). See report/REPORT.md.
export const series = ['var(--color-blue-500)', 'var(--color-green-500)', '#FF6D00'];

// TODO(ds-migration) js-token-reference `cardBorder`: Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute). See report/REPORT.md.
export const cardBorder = '1px solid var(--color-gray-300)';

// These look like hex colours but are not colours.
export const anchorId = '#bad';
export const route = '#section-2';
