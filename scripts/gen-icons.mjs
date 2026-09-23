#!/usr/bin/env node
/**
 * gen-icons.mjs — verifier for the committed iOS app icon.
 *
 * The illustrated 1024×1024 composite lives in
 * `ios/StockHODL/Assets.xcassets/AppIcon.appiconset/icon-1024.png`.
 * This script does not draw it. It asserts the PNG is 1024×1024, 8-bit,
 * RGB with no alpha (IHDR color type 2 — iOS rejects an app icon that
 * carries an alpha channel even when every pixel is opaque), and rewrites
 * Contents.json as the one universal 1024 iOS entry.
 *
 * Run: node scripts/gen-icons.mjs   (or: pnpm gen:icons)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPICONSET = join(ROOT, 'ios', 'StockHODL', 'Assets.xcassets', 'AppIcon.appiconset');
const ICON = join(APPICONSET, 'icon-1024.png');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const APPICON_CONTENTS = `${JSON.stringify(
  {
    images: [
      {
        filename: 'icon-1024.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
    ],
    info: { author: 'xcode', version: 1 },
  },
  null,
  2,
)}\n`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let bytes;
try {
  bytes = readFileSync(ICON);
} catch {
  fail(`Missing app icon at ${ICON}. Commit the illustrated 1024 RGB composite.`);
}

if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
  fail(`${ICON} is not a PNG (missing signature).`);
}

const ihdrLength = bytes.readUInt32BE(8);
if (ihdrLength !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
  fail(`${ICON} has no IHDR chunk — not a valid PNG.`);
}

const width = bytes.readUInt32BE(16);
const height = bytes.readUInt32BE(20);
const bitDepth = bytes[24];
const colorType = bytes[25];

if (width !== 1024 || height !== 1024) {
  fail(`${ICON} is ${width}×${height}; the iOS universal icon must be 1024×1024.`);
}
if (bitDepth !== 8) {
  fail(`${ICON} is bit depth ${bitDepth}; the iOS universal icon must be 8-bit.`);
}
if (colorType !== 2) {
  fail(
    `${ICON} is PNG color type ${colorType}, not 2 (RGB). ` +
      'iOS rejects an app icon that carries an alpha channel even when every pixel is opaque. ' +
      'Re-export without alpha (IHDR color type 2).',
  );
}

mkdirSync(APPICONSET, { recursive: true });
writeFileSync(join(APPICONSET, 'Contents.json'), APPICON_CONTENTS);
console.log(`${'AppIcon.appiconset'.padEnd(24)} ${String(bytes.length).padStart(7)} bytes (verified RGB 1024)`);
