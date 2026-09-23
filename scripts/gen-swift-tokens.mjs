/**
 * Design-token codegen: `src/styles/tokens.css` → `Tokens.swift` (plan C0).
 *
 * Non-negotiable #2 says `tokens.css` is the ONLY file in this repo allowed a
 * color literal. A native client is a second renderer of the same design
 * system, and hand-copying thirty OKLCH triples into Swift would break that
 * rule on day one and then drift quietly forever. So the Swift is generated
 * from the CSS, committed, and checked by the same CI job that guards the API
 * contracts.
 *
 * What is emitted is the OKLCH triple, NOT an RGB approximation. The
 * conversion happens at runtime in `ios/StockHODL/Design/OKLCH.swift`, for two
 * reasons: the generator stays a dumb extractor with no color science in it,
 * and the phone renders into Display P3 exactly as the OKLCH source intends,
 * instead of being handed a pre-flattened sRGB value that would visibly
 * desaturate the gain green.
 *
 * Run: `pnpm tokens:gen`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src/styles/tokens.css');
const OUT_DIR = join(ROOT, 'ios/StockHODLShared/Generated');
const OUT_FILE = join(OUT_DIR, 'Tokens.swift');

/**
 * Only Layer 1 is a source of values. Layer 2 (`@theme inline`) maps them onto
 * Tailwind utility names and holds nothing but `var()` indirection and a font
 * stack — reading it would produce tokens whose value is the string
 * "var(--surface-0)".
 */
function block(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No \`${selector}\` block in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  if (open === -1 || close === -1) throw new Error(`Unterminated \`${selector}\` block`);
  return css.slice(open + 1, close);
}

/** `--surface-0: oklch(0.16 0.011 260);` → `['surface-0', [0.16, 0.011, 260]]` */
function parseTokens(body, selector) {
  const tokens = new Map();
  const declaration = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;

  for (const [, name, rawValue] of body.matchAll(declaration)) {
    const value = rawValue.trim();
    const oklch = value.match(
      /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i,
    );
    if (!oklch) {
      // Loud rather than skipped: a token in a format this script does not
      // understand is a token the phone would silently not have.
      throw new Error(
        `\`--${name}\` in \`${selector}\` is \`${value}\`, which is not a plain oklch() triple. ` +
          'Teach this script the new format, or the iOS client loses the token.',
      );
    }
    tokens.set(name, oklch.slice(1, 4).map(Number));
  }

  if (tokens.size === 0) throw new Error(`No tokens found in \`${selector}\``);
  return tokens;
}

/** `surface-0` → `surface0`, `text-primary` → `textPrimary`. */
function swiftName(cssName) {
  return cssName.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function literal([l, c, h]) {
  return `OKLCH(l: ${l}, c: ${c}, h: ${h})`;
}

function main() {
  const css = readFileSync(SOURCE, 'utf8');

  const dark = parseTokens(block(css, ':root {'), ':root');
  const light = parseTokens(block(css, ":root[data-theme='light']"), ":root[data-theme='light']");

  const missing = [...dark.keys()].filter((name) => !light.has(name));
  if (missing.length) {
    // A token defined only in dark would render as dark-on-white in light
    // mode. The CSS cascade hides this (light inherits from :root); Swift has
    // no cascade, so the generator has to be the one to notice.
    throw new Error(
      `Defined for dark but not for light: ${missing.join(', ')}. ` +
        'Add the light value to tokens.css, or the iOS client has no light variant.',
    );
  }

  const extra = [...light.keys()].filter((name) => !dark.has(name));
  if (extra.length) throw new Error(`Defined for light but not for dark: ${extra.join(', ')}`);

  const lines = [
    '//',
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    '// Source of truth: src/styles/tokens.css.',
    '// Regenerate:      pnpm tokens:gen',
    '//',
    '// Non-negotiable #2: tokens.css is the only file allowed a color literal.',
    '// This file is the iOS half of that rule — generated, never authored. CI',
    '// regenerates it and fails on `git diff --exit-code`.',
    '//',
    '// Values are OKLCH, exactly as the CSS states them. The conversion to a',
    '// renderable color lives in Design/OKLCH.swift.',
    '//',
    '',
    'import Foundation',
    '',
    '/// A design token: the same hue in both schemes, never one value with a',
    '/// runtime `if`. Which one applies is the renderer\'s decision, not the',
    '/// token\'s.',
    'struct DesignToken: Equatable, Sendable {',
    '    let dark: OKLCH',
    '    let light: OKLCH',
    '',
    '    func value(for scheme: TokenScheme) -> OKLCH {',
    '        switch scheme {',
    '        case .dark: return dark',
    '        case .light: return light',
    '        }',
    '    }',
    '}',
    '',
    '/// Deliberately not `SwiftUI.ColorScheme`: this file stays free of UI',
    '/// framework imports so the token table can be unit-tested anywhere.',
    'enum TokenScheme: Sendable {',
    '    case dark',
    '    case light',
    '}',
    '',
    'enum Tokens {',
  ];

  for (const [name, darkValue] of dark) {
    lines.push(
      `    static let ${swiftName(name)} = DesignToken(`,
      `        dark: ${literal(darkValue)},`,
      `        light: ${literal(light.get(name))}`,
      '    )',
    );
  }

  lines.push(
    '',
    '    /// Every token, for the gamut test in StockHODLTests. A token that is',
    '    /// added to the CSS and not to this list would go unchecked.',
    '    static let all: [(name: String, token: DesignToken)] = [',
    ...[...dark.keys()].map((name) => `        ("${name}", ${swiftName(name)}),`),
    '    ]',
    '}',
    '',
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, lines.join('\n'));

  console.log(`Wrote ${dark.size} tokens to ${OUT_FILE.replace(`${ROOT}/`, '')}`);
}

main();
