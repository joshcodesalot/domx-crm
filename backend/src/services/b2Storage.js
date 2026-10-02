const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

class B2StorageError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'B2StorageError';
    this.status = status;
  }
}

let client;
let sdk;

function loadSdk() {
  if (sdk) return sdk;
  try {
    const s3 = require('@aws-sdk/client-s3');
    const storage = require('@aws-sdk/lib-storage');
    const presigner = require('@aws-sdk/s3-request-presigner');
    sdk = {
      S3Client: s3.S3Client,
      PutObjectCommand: s3.PutObjectCommand,
      GetObjectCommand: s3.GetObjectCommand,
      DeleteObjectCommand: s3.DeleteObjectCommand,
      Upload: storage.Upload,
      getSignedUrl: presigner.getSignedUrl,
    };
  } catch (err) {
    throw new B2StorageError(
      'Backblaze storage is not available. Install backend dependencies and set the B2 env vars.',
      503
    );
  }
  return sdk;
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new B2StorageError(`${name} is not configured`, 503);
  }
  return value;
}

function bucket() {
  return requireEnv('B2_BUCKET');
}

function getS3() {
  if (client) return client;
  const { S3Client } = loadSdk();
  client = new S3Client({
    endpoint: requireEnv('B2_ENDPOINT'),
    region: requireEnv('B2_REGION'),
    credentials: {
      accessKeyId: requireEnv('B2_KEY_ID'),
      secretAccessKey: requireEnv('B2_APPLICATION_KEY'),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumCalculation: 'WHEN_REQUIRED',
  });
  return client;
}

function vaultOriginalKey(creatorId, itemId) {
  return `telegram-vault/${creatorId}/${itemId}/original`;
}

function vaultThumbKey(creatorId, itemId) {
  return `telegram-vault/${creatorId}/${itemId}/thumb.jpg`;
}

async function putVaultObject(key, filePath, contentType) {
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) {
    throw new B2StorageError('Upload file is missing', 400);
  }
  const size = fs.statSync(abs).size;
  const Bucket = bucket();
  const ContentType = contentType || 'application/octet-stream';
  const { PutObjectCommand, Upload } = loadSdk();
  if (size > MULTIPART_THRESHOLD) {
    const upload = new Upload({
      client: getS3(),
      params: {
        Bucket,
        Key: key,
        Body: fs.createReadStream(abs),
        ContentType,
        ContentLength: size,
      },
    });
    await upload.done();
    return size;
  }
  await getS3().send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: fs.createReadStream(abs),
      ContentType,
      ContentLength: size,
    })
  );
  return size;
}

function isMissingObject(err) {
  const name = err?.name || err?.Code || '';
  const status = err?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

async function getVaultObject(key) {
  const { GetObjectCommand } = loadSdk();
  try {
    return await getS3().send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
      })
    );
  } catch (err) {
    if (err instanceof B2StorageError) throw err;
    if (isMissingObject(err)) {
      throw new B2StorageError('Vault file was not found in storage', 404);
    }
    throw new B2StorageError(err.message || 'Failed to read vault storage', 502);
  }
}

async function downloadVaultObjectToFile(key, destPath) {
  const obj = await getVaultObject(key);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!obj.Body || typeof obj.Body.pipe !== 'function') {
    const bytes = await obj.Body.transformToByteArray();
    fs.writeFileSync(destPath, Buffer.from(bytes));
    return destPath;
  }
  await pipeline(obj.Body, fs.createWriteStream(destPath));
  return destPath;
}

const PRESIGN_SECONDS = 60 * 60;

async function presignVaultObject(key, { contentType, filename, expiresIn = PRESIGN_SECONDS } = {}) {
  const { GetObjectCommand, getSignedUrl } = loadSdk();
  const name = String(filename || 'media').replace(/"/g, '');
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentType: contentType || 'application/octet-stream',
    ResponseContentDisposition: `inline; filename="${name}"`,
  });
  try {
    return await getSignedUrl(getS3(), command, { expiresIn });
  } catch (err) {
    if (err instanceof B2StorageError) throw err;
    throw new B2StorageError(err.message || 'Failed to sign vault storage', 502);
  }
}

async function streamVaultObject(res, key, { contentType, filename } = {}) {
  const obj = await getVaultObject(key);
  const name = String(filename || 'media').replace(/"/g, '');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Type', contentType || obj.ContentType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  if (obj.ContentLength != null) {
    res.setHeader('Content-Length', String(obj.ContentLength));
  }
  if (!obj.Body || typeof obj.Body.pipe !== 'function') {
    const bytes = await obj.Body.transformToByteArray();
    return res.end(Buffer.from(bytes));
  }
  obj.Body.on('error', (err) => {
    console.error('[b2] Vault stream failed:', err.message || err);
    if (!res.headersSent) res.status(502);
    res.end();
  });
  return obj.Body.pipe(res);
}

async function deleteVaultObjects(keys) {
  const unique = [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
  if (!unique.length) return;
  const { DeleteObjectCommand } = loadSdk();
  const s3 = getS3();
  const Bucket = bucket();
  for (const Key of unique) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    } catch (err) {
      if (isMissingObject(err)) continue;
      throw new B2StorageError(err.message || 'Failed to delete vault storage', 502);
    }
  }
}

module.exports = {
  B2StorageError,
  vaultOriginalKey,
  vaultThumbKey,
  putVaultObject,
  getVaultObject,
  downloadVaultObjectToFile,
  presignVaultObject,
  streamVaultObject,
  deleteVaultObjects,
};
