/**
 * The `/api/mobile/v1/*` contract surface, in one place.
 *
 * TWO consumers, and both matter:
 *  1. the route handlers in `src/app/api/mobile/v1/**`, which parse every
 *     request body and query with the schemas below;
 *  2. `scripts/gen-swift-contracts.mjs`, which walks THIS module's exports,
 *     runs each through zod 4's native `z.toJSONSchema()` and hands the
 *     result to quicktype (plan A.3).
 *
 * A schema that is exported here but parsed nowhere is a liability — it will
 * drift from the payload it claims to describe and nothing will notice. Add
 * the runtime use in the same change that adds the schema.
 *
 * Versioning: this tree describes v1. A breaking change goes to
 * `contracts/v2/` and v1 stays alive as long as a TestFlight build that
 * speaks it is still installed on the phone — the client is not deployed with
 * the server and cannot be assumed to have moved.
 */

export * from './common';
export * from './day-report';
export * from './analytics';
export * from './bootstrap';
export * from './dividends';
export * from './fx';
export * from './imports';
export * from './instrument';
export * from './live-payload';
export * from './market-strip';
export * from './news';
export * from './notification-preferences';
export * from './options';
export * from './passkeys';
export * from './portfolios';
export * from './price-targets';
export * from './push';
export * from './series';
export * from './settings';
export * from './symbols';
export * from './targets';
export * from './transactions';
export * from './trend';
export * from './watchlist';
export * from './widget';
