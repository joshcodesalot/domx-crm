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
 * Bake EXIF orientation, convert HDR/P3 to sRGB JPEG, optionally downscale.
 * Matches native 4Based/Maloum website canvas export so thumbs are not washed out.
 *
 * @param {Buffer} buffer
 * @param {{ mimeType?: string, maxEdge?: number }} [options]
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, mimeType: string }>}
 */
async function prepareFeedPhoto(buffer, { mimeType = '', maxEdge } = {}) {
  const inputMime = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';

  try {
    let pipeline = sharp(buffer, { failOn: 'none' })
      .rotate()
      .pipelineColourspace('rgb16')
      .toColourspace('srgb');

    if (typeof pipeline.withIccProfile === 'function') {
      pipeline = pipeline.withIccProfile('srgb');
    }

    const edge = Number(maxEdge);
    if (Number.isFinite(edge) && edge > 0) {
      pipeline = pipeline.resize({
        width: Math.round(edge),
        height: Math.round(edge),
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const outBuffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
    const orientedMeta = await sharp(outBuffer).metadata();
    const width = Number(orientedMeta.width);
    const height = Number(orientedMeta.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error('Invalid prepared dimensions');
    }

    return { buffer: outBuffer, width, height, mimeType: 'image/jpeg' };
  } catch {
    return fallbackDims(buffer, inputMime);
  }
}

async function autoOrientImage(buffer, mimeType = '') {
  return prepareFeedPhoto(buffer, { mimeType });
}

module.exports = { prepareFeedPhoto, autoOrientImage };
