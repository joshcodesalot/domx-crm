const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  isServableCacheFile,
  startProgressiveDownload,
  pipeProgressiveMedia,
} = require('./telegramProgressiveMedia');

function createMockResponse() {
  const ee = new EventEmitter();
  const chunks = [];
  let markFirst;
  const firstBytes = new Promise((resolve) => {
    markFirst = resolve;
  });
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      this.headers = headers;
    },
    write(buf) {
      chunks.push(Buffer.from(buf));
      if (chunks.length === 1) markFirst();
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
      ee.emit('close');
    },
    on(event, fn) {
      ee.on(event, fn);
      return this;
    },
    off(event, fn) {
      ee.off(event, fn);
      return this;
    },
    once(event, fn) {
      ee.once(event, fn);
      return this;
    },
  };
  return { res, chunks, firstBytes };
}

describe('progressive telegram video', () => {
  it('sends the start of a bytes=0- response before the download finishes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stream-'));
    const destPath = path.join(dir, 'clip.mp4');
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const session = startProgressiveDownload({
      destPath,
      totalSize: 10,
      iterate: async function* chunks() {
        yield Buffer.from('hello');
        await gate;
        yield Buffer.from('world');
      },
    });
    const { res, chunks, firstBytes } = createMockResponse();
    const piping = pipeProgressiveMedia(res, session, {
      rangeHeader: 'bytes=0-',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
    });

    await firstBytes;
    assert.equal(session.done, false);
    assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), 'hello');
    assert.equal(isServableCacheFile(session.partialPath), false);
    assert.equal(isServableCacheFile(destPath), false);
    assert.equal(fs.existsSync(session.partialPath), true);
    assert.equal(fs.statSync(session.partialPath).size > 0, true);
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['Content-Range'], 'bytes 0-9/10');

    release();
    await piping;
    await session.finished;
    assert.equal(Buffer.concat(chunks).toString(), 'helloworld');
    assert.equal(isServableCacheFile(destPath), true);
    assert.equal(fs.existsSync(session.partialPath), false);
    assert.equal(fs.readFileSync(destPath).toString(), 'helloworld');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers a short range probe before the rest of the file arrives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stream-'));
    const destPath = path.join(dir, 'clip.mp4');
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const session = startProgressiveDownload({
      destPath,
      totalSize: 10,
      iterate: async function* chunks() {
        yield Buffer.from('hello');
        await gate;
        yield Buffer.from('world');
      },
    });
    const { res, chunks } = createMockResponse();
    await pipeProgressiveMedia(res, session, {
      rangeHeader: 'bytes=0-1',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
    });
    assert.equal(session.done, false);
    assert.equal(Buffer.concat(chunks).toString(), 'he');
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['Content-Range'], 'bytes 0-1/10');
    assert.equal(isServableCacheFile(session.partialPath), false);

    release();
    const info = await session.finished;
    assert.equal(info.error, null);
    assert.equal(isServableCacheFile(destPath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
