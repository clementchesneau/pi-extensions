// The formats Pi can resize and every image-capable provider accepts, recognized by their signature.
/** @type {[string, (bytes: Buffer) => boolean][]} */
const SIGNATURES = [
  ['image/png', bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', bytes => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
  ['image/gif', bytes => /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))],
  ['image/webp', bytes => bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'],
];
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

export const IMAGE_TYPES = SIGNATURES.map(([mimeType]) => mimeType);

/**
 * An image for the model, typed by its file signature: a declared type can be wrong, and a model
 * provider rejects an image whose bytes do not match its type, on every later turn too.
 * @param {Uint8Array | undefined} bytes
 * @param {string} declaredType
 * @param {string} finalUrl
 */
export function imagePage(bytes, declaredType, finalUrl) {
  const buffer = Buffer.from(bytes ?? []);
  const mimeType = SIGNATURES.find(([, matches]) => matches(buffer))?.[0];
  if (mimeType) {
    return { title: finalUrl, extraction: 'image', markdown: '', image: { data: buffer.toString('base64'), mimeType } };
  }
  if (RASTER_TYPES.has(declaredType)) {
    throw new Error(`The content is declared as ${declaredType} but is not a PNG, JPEG, GIF or WebP image.`);
  }
  throw new Error(`Unsupported image type: ${declaredType}. Supports PNG, JPEG, GIF and WebP images.`);
}
