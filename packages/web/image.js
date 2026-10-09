import { resizeImage } from '@earendil-works/pi-coding-agent';

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

/** The image type the file signature shows, or undefined. @param {Uint8Array | undefined} bytes */
export const imageType = bytes => SIGNATURES.find(([, matches]) => matches(Buffer.from(bytes ?? [])))?.[0];

/**
 * An image for the model, typed by its file signature and fully decoded: a declared type can be
 * wrong, and a model provider rejects an image whose bytes do not match its type, on every later
 * turn too.
 * @param {Uint8Array | undefined} bytes
 * @param {string} declaredType
 * @param {string} finalUrl
 */
export async function imagePage(bytes, declaredType, finalUrl) {
  const buffer = Buffer.from(bytes ?? []);
  const mimeType = imageType(buffer);
  if (mimeType) {
    // Decoding with Pi's own image backend proves the bytes are a whole image: Pi keeps an image
    // it cannot decode in the history, and the provider may then reject every later request.
    const decoded = await resizeImage(buffer, mimeType);
    if (!decoded) throw new Error(`The ${mimeType} image cannot be decoded: it may be truncated or corrupt.`);
    const image = { data: decoded.data, mimeType: decoded.mimeType };
    return { title: finalUrl, extraction: 'image', markdown: '', image };
  }
  if (RASTER_TYPES.has(declaredType)) {
    throw new Error(`The content is declared as ${declaredType} but is not a PNG, JPEG, GIF or WebP image.`);
  }
  throw new Error(`Unsupported image type: ${declaredType}. Supports PNG, JPEG, GIF and WebP images.`);
}
