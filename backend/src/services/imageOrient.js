const sharp = require('sharp');
const { imageSize } = require('image-size');

function fallbackDims(buffer, inputMime) {
  const dimensions = imageSize(buffer);
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  return {
    buffer,
    width,
    height,
    mimeType: inputMime || 'application/octet-stream',
  };
}

/**
 * Bake EXIF orientation into pixel data so width/height match visual display.
 * Skips re-encode when orientation is already 1 / missing.
 * Falls back to the original buffer + image-size if sharp fails.
 *
 * @param {Buffer} buffer
 * @param {string} [mimeType]
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, mimeType: string }>}
 */
async function autoOrientImage(buffer, mimeType = '') {
  const inputMime = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';

  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const orientation = Number(meta.orientation) || 1;
    if (orientation === 1) {
      const width = Number(meta.width);
      const height = Number(meta.height);
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        return {
          buffer,
          width,
          height,
          mimeType: inputMime || 'application/octet-stream',
        };
      }
      return fallbackDims(buffer, inputMime);
    }

    const format = (meta.format || '').toLowerCase();
    let outMime = 'image/jpeg';
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate().keepIccProfile();

    if (inputMime.includes('png') || format === 'png') {
      outMime = 'image/png';
      pipeline = pipeline.png();
    } else if (inputMime.includes('webp') || format === 'webp') {
      outMime = 'image/webp';
      pipeline = pipeline.webp({ quality: 92 });
    } else {
      outMime = 'image/jpeg';
      pipeline = pipeline.jpeg({ quality: 92 });
    }

    const outBuffer = await pipeline.toBuffer();
    const orientedMeta = await sharp(outBuffer).metadata();
    const width = Number(orientedMeta.width);
    const height = Number(orientedMeta.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error('Invalid oriented dimensions');
    }

    return { buffer: outBuffer, width, height, mimeType: outMime };
  } catch {
    return fallbackDims(buffer, inputMime);
  }
}

module.exports = { autoOrientImage };
