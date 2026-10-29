const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { prepareTelegramPhoto } = require('./telegramWorker');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-photo-test-'));

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function writeSolid(name, width, height, progressive) {
  const file = path.join(root, name);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .jpeg({ quality: 80, progressive: Boolean(progressive) })
    .toFile(file);
  return file;
}

describe('prepareTelegramPhoto', () => {
  it('leaves a small baseline JPEG unchanged', async () => {
    const src = await writeSolid('small.jpg', 640, 480, false);
    const before = fs.statSync(src).size;
    const prepared = await prepareTelegramPhoto(src, path.join(root, 'small-out'));
    assert.equal(prepared.rewritten, false);
    assert.equal(prepared.filePath, path.resolve(src));
    assert.equal(fs.statSync(src).size, before);
  });

  it('rewrites a JPEG whose sides add up to more than 10000', async () => {
    const src = await writeSolid('big.jpg', 6400, 4000, false);
    const sourceMeta = await sharp(src).metadata();
    const prepared = await prepareTelegramPhoto(src, path.join(root, 'big-out'));
    assert.equal(prepared.rewritten, true);
    assert.notEqual(path.resolve(prepared.filePath), path.resolve(src));
    const out = await sharp(prepared.filePath).metadata();
    assert.equal(out.format, 'jpeg');
    assert.equal(Boolean(out.isProgressive), false);
    assert.equal(out.width + out.height <= 10_000, true);
    assert.equal(Math.max(out.width, out.height) / Math.min(out.width, out.height) <= 20, true);
    assert.equal(fs.statSync(prepared.filePath).size <= 10 * 1024 * 1024, true);
    const still = await sharp(src).metadata();
    assert.equal(still.width, sourceMeta.width);
    assert.equal(still.height, sourceMeta.height);
  });

  it('pads a JPEG whose long side is more than 20 times the short side', async () => {
    const src = await writeSolid('wide.jpg', 3000, 50, false);
    const prepared = await prepareTelegramPhoto(src, path.join(root, 'wide-out'));
    assert.equal(prepared.rewritten, true);
    const out = await sharp(prepared.filePath).metadata();
    assert.equal(out.width + out.height <= 10_000, true);
    assert.equal(Math.max(out.width, out.height) / Math.min(out.width, out.height) <= 20, true);
    const still = await sharp(src).metadata();
    assert.equal(still.width, 3000);
    assert.equal(still.height, 50);
  });
});
