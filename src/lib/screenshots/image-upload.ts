/**
 * The screenshot-upload contract, shared by every import path (options since
 * 2026-08-15, transactions since this plan).
 *
 * Isomorphic and deliberately NOT `server-only` — the same two constants bound
 * both sides of the same wire: the CLIENT downscales to `MAX_IMAGE_LONG_EDGE_PX`
 * and refuses anything still over `MAX_IMPORT_IMAGE_BYTES` before spending an
 * upload, while the SERVER re-checks the decoded bytes against the identical
 * cap and sniffs the real type. The client's checks are a courtesy; the server
 * ones are the control, and `decodeUploadedImage` is where that control lives.
 */

/** Hard cap on the decoded image, bytes. Base64 of this is ~3.4 MB, inside
 *  the 4 MB Server Action body limit raised in next.config.ts. */
export const MAX_IMPORT_IMAGE_BYTES = 2_621_440;

/** The vision service's documented long-edge maximum, px — the client
 *  downscales to this before upload (1260×2736 → 1186×2576). */
export const MAX_IMAGE_LONG_EDGE_PX = 2576;

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Magic-byte sniff — PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF….WEBP`.
 * Never the filename, never the client-declared type: the sniffed type is
 * what goes onward as the vision request's media type. Anything else
 * (renamed PDF, SVG, empty buffer) is null → rejected.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Strict base64: the exact alphabet, correct padding — anything else is
 *  rejected rather than silently "decoded" (Buffer ignores junk chars). */
export const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Ceiling for the base64 STRING length implied by the decoded-byte cap —
 *  checked before any decode so an oversized body is refused cheaply. */
export const MAX_IMPORT_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMPORT_IMAGE_BYTES / 3) * 4;

/**
 * The server-side upload gate, in the one order that is load-bearing:
 * padding/length → alphabet → decode → decoded-size cap → magic-byte sniff.
 * Anything that fails at any step is a single `null` — the caller reports one
 * indistinguishable `invalid_image`, so a probe learns nothing about which
 * check it tripped.
 *
 * The returned `mediaType` is the SNIFFED type; the client's claim about the
 * file is never read anywhere in this path.
 */
export function decodeUploadedImage(
  base64: string,
): { bytes: Buffer; mediaType: SniffedImageType } | null {
  if (base64.length === 0 || base64.length > MAX_IMPORT_IMAGE_BASE64_LENGTH) return null;
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return null;

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMPORT_IMAGE_BYTES) return null;

  const mediaType = sniffImageType(bytes);
  if (mediaType === null) return null;

  return { bytes, mediaType };
}

/**
 * Every way a screenshot parse can fail, shared by both parse actions and
 * both import components. Client-only failure modes (a file the canvas cannot
 * decode, an image still too big after downscaling) are added on top of this
 * union by the components, never here — the server never sees them.
 */
export type ScreenshotParseFailure =
  | 'signed-out'
  | 'rate_limited'
  | 'invalid_image'
  | 'not_configured'
  | 'refused'
  | 'unparseable'
  | 'unavailable';
