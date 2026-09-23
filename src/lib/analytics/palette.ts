import { UNKNOWN_KEY } from './allocation';

/**
 * Category colours for the allocation breakdown — TOKEN NAMES ONLY.
 *
 * Non-negotiable #2: `src/styles/tokens.css` is the only file in this repo
 * allowed a colour literal. This module therefore returns `var(--color-cat-N)`
 * strings, which Recharts hands straight to SVG attributes and the browser
 * resolves natively — the same discipline `value-chart.tsx` follows for
 * gain/loss. Nothing here knows what any of these colours look like, and a
 * theme switch repaints every slice with no JS involved.
 *
 * Colour is never the only carrier: every slice is also named in text with
 * its amount and its share, so the chart is readable with colour filters off.
 */

/** How many category tokens exist. Index 8 wraps back to `--color-cat-1`. */
export const CATEGORY_COLOR_COUNT = 8;

/**
 * Bucket index → category token. The wrap is DELIBERATE and documented: a
 * breakdown with more than eight slices repeats colours rather than inventing
 * a ninth token, because the label beside each slice is what identifies it.
 * Negative indices wrap the same way (the double-modulo), so a caller cannot
 * produce `--color-cat-0` or `--color-cat--3`.
 */
export function categoryColorVar(index: number): string {
  const slot = ((index % CATEGORY_COLOR_COUNT) + CATEGORY_COLOR_COUNT) % CATEGORY_COLOR_COUNT;
  return `var(--color-cat-${slot + 1})`;
}

/**
 * The colour for one slice. The Unknown bucket is PINNED to its own token
 * regardless of where it sorts — an unclassified slice that borrows a
 * category colour reads as a category.
 */
export function sliceColorVar(key: string, index: number): string {
  return key === UNKNOWN_KEY ? 'var(--color-cat-unknown)' : categoryColorVar(index);
}
