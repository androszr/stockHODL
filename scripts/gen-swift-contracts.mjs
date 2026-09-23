/**
 * Contract codegen: zod → JSON Schema → Swift (plan A.3).
 *
 * The Swift client is not deployed with the server, so a struct hand-copied
 * from `LivePayload` drifts the moment someone adds a field — and drifts
 * SILENTLY, because a missing key in a `Codable` optional just decodes to nil.
 * This script removes the hand-copying: `src/lib/api/contracts/` is the one
 * source, and CI fails when the checked-in Swift no longer matches it.
 *
 * Pipeline, per plan A.3:
 *   1. walk the exports of `src/lib/api/contracts/index.ts`;
 *   2. put them in a zod REGISTRY and convert the registry in one pass, so a
 *      shape used by two contracts becomes one `$ref` instead of two copies.
 *      Converting each schema on its own produced `LiveHoldingClass`,
 *      `PurpleCachedPrice` and friends — quicktype cannot know two inlined
 *      objects are the same type, so it invents a name for each;
 *   3. assemble ONE document whose `$defs` hold every type, since quicktype
 *      only shares types within a single source graph;
 *   4. quicktype → `ios/StockHODL/Generated/Contracts.swift`, committed.
 *
 * Money stays `String` all the way through: the contracts declare decimal
 * amounts as `z.string()`, JSON Schema carries `"type": "string"`, and
 * quicktype emits `String`. There is no path by which a price becomes a
 * `Double` here — the conversion to `Decimal` happens only in the hand-written
 * mapping layer (`ios/StockHODL/Money/Money.swift`), which is the whole point
 * of non-negotiable #1 surviving the port.
 *
 * Run: `pnpm contracts:gen`
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import * as contractsModule from '../src/lib/api/contracts/index.ts';

/**
 * `package.json` has no `"type": "module"`, so tsx transpiles the contracts to
 * CommonJS and this ESM script sees the whole barrel hanging off `default`
 * rather than as named exports. Unwrapping it here is less disruptive than
 * flipping the module system of a Next app for the benefit of one script.
 */
const contracts = contractsModule.default ?? contractsModule;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'ios/StockHODLShared/Generated');
const OUT_FILE = join(OUT_DIR, 'Contracts.swift');
const VERSION_FILE = join(OUT_DIR, 'ContractsVersion.swift');

/**
 * Intermediates land on `*.tmp`, which `.gitignore` covers — the generated
 * Swift is committed, the JSON Schema that produced it is not. Keeping the
 * scratch inside the output directory (rather than in the system temp) means a
 * failed run leaves its evidence exactly where someone would look for it.
 */
const TMP_DIR = join(OUT_DIR, 'schemas.tmp');

/** `livePayloadSchema` → `LivePayload`. */
function typeName(exportName) {
  const base = exportName.replace(/Schema$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Types the phone only ever DECODES are generated. Request bodies are not, and
 * the asymmetry is deliberate rather than lazy:
 *
 *   - a response that drifts fails silently — a renamed field decodes to nil
 *     and a screen quietly shows "—" forever;
 *   - a request that drifts fails loudly — the handler's `safeParse` answers
 *     400 with the offending field named, in the same message the web form
 *     would show.
 *
 * On top of that, the input schemas carry transforms (`.trim()`,
 * `.toUpperCase()`, the pl-PL comma normalisation), and a JSON Schema
 * describes a shape, not a transform: generating from them would emit a struct
 * for the POST-transform value the client never actually sends. Requests are
 * hand-written against `src/lib/validation.ts`, which stage C4 treats as the
 * spec it is.
 */
const REQUEST_ONLY = new Set([
  'transactionCreateSchema',
  'transactionUpdateSchema',
  'transactionListQuerySchema',
  'portfolioCreateSchema',
  'portfolioRenameSchema',
  'portfolioReorderSchema',
  'priceTargetCreateRequestSchema',
  'targetsPutRequestSchema',
  'watchlistAddRequestSchema',
  'fxRateQuerySchema',
  'portfolioSeriesQuerySchema',
  'priceSeriesQuerySchema',
  'marketSeriesKeyParamSchema',
  'symbolParamSchema',
  'symbolSearchQuerySchema',
  'optionPositionAddRequestSchema',
  'optionPositionEditRequestSchema',
  'optionExpirationsQuerySchema',
  'optionStrikesQuerySchema',
  'optionsRangeQuerySchema',
]);

/**
 * Primitives that exist to keep the TypeScript honest but that would land in
 * Swift as a one-field wrapper around a String. `decimalStringSchema` is the
 * clearest case: its whole job is to be a string that nobody parses.
 */
const NOT_A_TYPE = new Set([
  'uuidSchema',
  'isoDateSchema',
  'currencySchema',
  'decimalStringSchema',
  'displayStringSchema',
  'epochMsSchema',
  'directionSchema',
  'chartRangeSchema',
  'symbolParamSchema',
]);

/**
 * The wrapper type quicktype names after the source file. A JSON Schema
 * document needs a single root, and only types reachable from that root get
 * emitted — so the root is an object listing every contract, and the struct it
 * produces is discarded below. Nothing decodes it.
 */
const ROOT_TYPE = 'MobileAPIIndex';

function collect() {
  const registry = z.registry();
  const names = [];
  const skipped = [];

  for (const [name, value] of Object.entries(contracts)) {
    if (!name.endsWith('Schema')) continue;

    if (NOT_A_TYPE.has(name)) {
      skipped.push([name, 'primitive — no Swift type of its own']);
      continue;
    }
    if (REQUEST_ONLY.has(name)) {
      skipped.push([name, 'request shape — hand-written, see the note above']);
      continue;
    }
    if (!(value instanceof z.ZodType)) {
      skipped.push([name, 'not a zod schema']);
      continue;
    }

    registry.add(value, { id: typeName(name) });
    names.push(typeName(name));
  }

  let schemas;
  try {
    ({ schemas } = z.toJSONSchema(registry, {
      target: 'draft-07',
      // The shape as it leaves the server, which is what the phone decodes.
      io: 'output',
      // A refinement has no JSON Schema equivalent; dropping it is correct
      // here, because validation is the server's job and the client's decoder
      // only needs the shape.
      unrepresentable: 'any',
      uri: (id) => `#/$defs/${id}`,
    }));
  } catch (error) {
    // Loud, not silent: an unconvertible schema means the phone has no type
    // for a payload it is about to receive.
    throw new Error(`Cannot convert the contracts to JSON Schema: ${error.message}`);
  }

  const $defs = {};
  for (const name of names) {
    // `$schema` and `$id` belong to a standalone document; nested under
    // `$defs` they only give quicktype a second, conflicting root to reason
    // about.
    const body = { ...schemas[name] };
    delete body.$schema;
    delete body.$id;
    // `title` is what quicktype names the type after. Without it, it invents a
    // name from the property that happens to reference the schema first —
    // which is how `livePayload` came out as `Live` and `LiveHolding` as
    // `LiveHoldingElement`. The `$defs` key alone is not enough.
    $defs[name] = { title: name, ...body };
  }

  const document = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: ROOT_TYPE,
    type: 'object',
    properties: Object.fromEntries(
      names.map((name) => [name, { $ref: `#/$defs/${name}` }]),
    ),
    required: names,
    additionalProperties: false,
    $defs,
  };

  return { document, names, skipped };
}

/**
 * Remove the root wrapper. It is emitted first, right after `import
 * Foundation`, and it is the only struct nothing references. Failing loudly
 * when it cannot be found matters: a silent miss would ship a dead 30-line
 * struct that looks like a real contract.
 */
function stripRootType(source) {
  const lines = source.split('\n');

  // Everything quicktype writes before `import Foundation` is a usage preamble
  // naming the wrapper we are about to delete. Our own header replaces it.
  const importAt = lines.indexOf('import Foundation');
  if (importAt === -1) throw new Error('No `import Foundation` in quicktype output.');

  const markAt = lines.indexOf(`// MARK: - ${ROOT_TYPE}`, importAt);
  if (markAt === -1) {
    throw new Error(
      `Could not find the ${ROOT_TYPE} wrapper to strip — quicktype's output shape changed.`,
    );
  }

  // The struct's own closing brace is the first line that is exactly `}`. Brace
  // COUNTING would be wrong here and a regex worse: the struct contains a
  // nested `CodingKeys` enum whose closing brace is indented, and matching to
  // the first `}` anywhere is what broke the previous version of this.
  let closeAt = -1;
  for (let i = markAt; i < lines.length; i += 1) {
    if (lines[i] === '}') {
      closeAt = i;
      break;
    }
  }
  if (closeAt === -1) throw new Error(`Unterminated ${ROOT_TYPE} struct in quicktype output.`);

  // Drop the trailing blank line with it, so the file does not open on a gap.
  const after = lines[closeAt + 1] === '' ? closeAt + 2 : closeAt + 1;
  return [...lines.slice(importAt, markAt), ...lines.slice(after)].join('\n');
}

function main() {
  const { document, names, skipped } = collect();

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const source = join(TMP_DIR, `${ROOT_TYPE}.json`);
  writeFileSync(source, `${JSON.stringify(document, null, 2)}\n`);

  mkdirSync(OUT_DIR, { recursive: true });

  execFileSync(
    'node',
    [
      join(ROOT, 'node_modules/quicktype/dist/index.js'),
      '--src-lang',
      'schema',
      '--lang',
      'swift',
      // Types only. The phone uses JSONDecoder directly; quicktype's
      // convenience initialisers would be dead code with their own opinions
      // about dates and URLs.
      // NOT `--just-types`: that flag drops the raw values off generated
      // enums, so `MarketStatus.earlyTrading` would carry the raw value
      // "earlyTrading" and fail to decode the wire's "early_trading". The
      // initialisers are what we actually did not want, so refuse those by
      // name and keep the CodingKeys.
      '--no-initializers',
      '--struct-or-class',
      'struct',
      '--density',
      'normal',
      '--sendable',
      // Keep `instrumentId` spelled the way the contract spells it. Swift
      // would prefer `instrumentID`, but one-to-one greppability between the
      // zod schema and the struct is worth more here than the convention.
      '--acronym-style',
      'original',
      // Without this the wrapper is named after the OUTPUT file, which would
      // give us a `Contracts` struct that reads like the real thing.
      '--top-level',
      ROOT_TYPE,
      '-o',
      OUT_FILE,
      source,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  rmSync(TMP_DIR, { recursive: true, force: true });

  const header = [
    '//',
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    '// Source of truth: src/lib/api/contracts/ (zod).',
    '// Regenerate:      pnpm contracts:gen',
    '//',
    '// CI runs the generator and fails on `git diff --exit-code` over this',
    '// directory, so an edit here is reverted by the next green build.',
    '//',
    '// Money is a String on purpose. Converting one to Decimal happens only in',
    '// Money.swift; a `Double` anywhere near a price is non-negotiable #1.',
    '//',
    '// One wart worth knowing: `open` is a Swift declaration modifier, so',
    '// quicktype spells that case `marketStatusOpen`. The RAW VALUE is still',
    '// "open" — the wire is unaffected, only the Swift identifier is ugly.',
    '//',
    '',
    '',
  ].join('\n');

  const swift = header + stripRootType(readFileSync(OUT_FILE, 'utf8'));
  writeFileSync(OUT_FILE, swift);
  writeContractsVersion(swift);

  console.log(`Wrote ${names.length} types to ${OUT_FILE.replace(`${ROOT}/`, '')}`);
  for (const name of names) console.log(`  + ${name}`);
  if (skipped.length) {
    console.log('Not generated, by decision:');
    for (const [name, why] of skipped) console.log(`  - ${name} (${why})`);
  }
}

/**
 * A fingerprint of the generated Swift, emitted as a Swift constant.
 *
 * The iOS client caches decoded payloads on disk so a screen opened without a
 * connection has something to draw. A cached file outlives an app update, and
 * an app update is exactly when these types change — so a payload written by
 * the old shape can be read back by the new one. `Codable` does not
 * necessarily refuse it: a field that changed meaning, or an added optional,
 * decodes cleanly and paints WRONG NUMBERS, which on a portfolio screen is the
 * one failure mode worth spending a build step to prevent.
 *
 * The hash keys every cache file, so a contract change makes every stored
 * payload a MISS rather than a silent reinterpretation. It is derived from the
 * emitted Swift rather than from the zod source because the Swift is what the
 * decoder actually obeys, and it lives in `Generated/` so CI's existing
 * `git diff --exit-code` over that directory keeps it honest without a second
 * check.
 */
function writeContractsVersion(swift) {
  const hash = createHash('sha256').update(swift).digest('hex').slice(0, 12);
  writeFileSync(
    VERSION_FILE,
    [
      '//',
      '// GENERATED FILE — DO NOT EDIT.',
      '//',
      '// A fingerprint of Contracts.swift, used to key on-disk caches so that',
      '// a payload written by an older build is never decoded by a newer one.',
      '// See `writeContractsVersion` in scripts/gen-swift-contracts.mjs.',
      '//',
      '',
      'enum ContractsVersion {',
      `    static let current = "${hash}"`,
      '}',
      '',
    ].join('\n'),
  );
  console.log(`Contracts fingerprint: ${hash}`);
}

main();
