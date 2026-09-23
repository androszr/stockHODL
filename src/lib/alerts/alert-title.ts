/**
 * The push alert's headline name — pure, isomorphic, no database. Split out
 * from `src/app/api/cron/check-price-alerts/route.ts` so the truncation rules
 * are testable without a vendor, a device token or a `@/lib/db` mock.
 */

/**
 * iOS renders roughly 30–35 characters of a notification title on the lock
 * screen. The percent is the point of the alert, so the NAME yields first:
 * bounded here, it can never push the move out of view.
 */
const MAX_NAME_LENGTH = 22;

/**
 * Nasdaq Trader security names carry a share-class tail after a dash —
 * `Apple Inc. - Common Stock`, `Alphabet Inc. - Class A Common Stock`. It is
 * noise in a headline about a price move, and it is what makes these names
 * long in the first place, so it goes before any truncation is considered.
 */
const CLASS_SUFFIX = /\s+-\s+.*$/;

/**
 * A short, human name for the alert title, falling back to `symbol` whenever
 * the stored name cannot produce one — an empty or dash-only `display_name`,
 * or a first word already longer than the budget. The caller pairs this with
 * the ticker in the notification BODY, so a fallback to the ticker is a
 * degraded headline, never lost information.
 */
export function alertDisplayName(displayName: string, symbol: string): string {
  const trimmed = displayName.replace(CLASS_SUFFIX, '').trim();
  if (trimmed.length === 0) return symbol;
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;

  // Cut on a word boundary — `Internation…` reads as a typo, `International…`
  // as a shortening. A first word that alone overflows has no boundary to cut
  // on, so the ticker is the honest headline.
  const clipped = trimmed.slice(0, MAX_NAME_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace <= 0) return symbol;
  return `${clipped.slice(0, lastSpace).trimEnd()}…`;
}
