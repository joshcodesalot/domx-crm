const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = require('../db/pool');
const { TelegramWorkerError, getCachedVaultMedia, deleteSavedVaultMessage } = require('../services/telegramWorker');
const {
  vaultOriginalKey,
  vaultThumbKey,
  putVaultObject,
} = require('../services/b2Storage');

function requireB2Env() {
  const names = ['B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'];
  const missing = names.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}`);
  }
}

function savedMessageAlreadyGone(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    err?.status === 404 ||
    msg.includes('not found') ||
    msg.includes('message_id_invalid') ||
    msg.includes('message id invalid')
  );
}

async function photoThumbFromFile(filePath) {
  const dest = path.join(
    os.tmpdir(),
    `domx-vault-migrate-thumb-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
  );
  await sharp(filePath, { failOn: 'none' })
    .rotate()
    .resize(320, 320, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(dest);
  return dest;
}

function unlinkQuiet(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

async function storeVaultBytes(row) {
  const full = await getCachedVaultMedia(row.creatorId, row.savedMessageId, 'full');
  const storageKey = vaultOriginalKey(row.creatorId, row.id);
  const byteSize = await putVaultObject(
    storageKey,
    full.filePath,
    full.mimeType || 'application/octet-stream'
  );
  let thumbKey = null;
  let generatedThumb = null;
  try {
    try {
      const thumb = await getCachedVaultMedia(row.creatorId, row.savedMessageId, 'thumb');
      thumbKey = vaultThumbKey(row.creatorId, row.id);
      await putVaultObject(thumbKey, thumb.filePath, 'image/jpeg');
    } catch (err) {
      if (row.kind === 'photo') {
        generatedThumb = await photoThumbFromFile(full.filePath);
        thumbKey = vaultThumbKey(row.creatorId, row.id);
        await putVaultObject(thumbKey, generatedThumb, 'image/jpeg');
      } else {
        console.warn(
          `[migrate] No thumb for ${row.id}:`,
          err instanceof Error ? err.message : err
        );
        thumbKey = null;
      }
    }
  } finally {
    unlinkQuiet(generatedThumb);
  }
  await pool.query(
    `UPDATE telegram_vault_items
     SET "storageKey" = $2,
         "thumbKey" = $3,
         "mimeType" = $4,
         "byteSize" = $5,
         "migratedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1`,
    [row.id, storageKey, thumbKey, full.mimeType || null, byteSize]
  );
  unlinkQuiet(full.filePath);
  return { storageKey, byteSize };
}

async function writeReceipt(row, storageKey, byteSize) {
  await pool.query(
    `INSERT INTO telegram_vault_saved_receipts (
       "creatorId", "itemId", "savedMessageId", "fileUniqueId", kind, "fileName",
       duration, width, height, "storageKey", "byteSize", "migratedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT ("creatorId", "savedMessageId")
     DO UPDATE SET
       "itemId" = COALESCE(EXCLUDED."itemId", telegram_vault_saved_receipts."itemId"),
       "fileUniqueId" = COALESCE(EXCLUDED."fileUniqueId", telegram_vault_saved_receipts."fileUniqueId"),
       kind = COALESCE(EXCLUDED.kind, telegram_vault_saved_receipts.kind),
       "fileName" = COALESCE(EXCLUDED."fileName", telegram_vault_saved_receipts."fileName"),
       duration = COALESCE(EXCLUDED.duration, telegram_vault_saved_receipts.duration),
       width = COALESCE(EXCLUDED.width, telegram_vault_saved_receipts.width),
       height = COALESCE(EXCLUDED.height, telegram_vault_saved_receipts.height),
       "storageKey" = COALESCE(EXCLUDED."storageKey", telegram_vault_saved_receipts."storageKey"),
       "byteSize" = COALESCE(EXCLUDED."byteSize", telegram_vault_saved_receipts."byteSize"),
       "migratedAt" = COALESCE(telegram_vault_saved_receipts."migratedAt", EXCLUDED."migratedAt")`,
    [
      row.creatorId,
      row.id,
      row.savedMessageId,
      row.fileUniqueId,
      row.kind,
      row.fileName,
      row.duration,
      row.width,
      row.height,
      storageKey,
      byteSize,
    ]
  );
}

async function deleteSavedMessage(row) {
  try {
    await deleteSavedVaultMessage(row.creatorId, row.savedMessageId);
  } catch (err) {
    if (!savedMessageAlreadyGone(err)) throw err;
  }
  await pool.query(
    `UPDATE telegram_vault_saved_receipts
     SET "savedMessageDeletedAt" = NOW()
     WHERE "creatorId" = $1 AND "savedMessageId" = $2`,
    [row.creatorId, row.savedMessageId]
  );
}

async function migrateOne(row) {
  let storageKey = row.storageKey;
  let byteSize = row.byteSize;
  if (!storageKey) {
    const stored = await storeVaultBytes(row);
    storageKey = stored.storageKey;
    byteSize = stored.byteSize;
  }
  if (!row.receiptId) {
    await writeReceipt(row, storageKey, byteSize);
  }
  if (!row.savedMessageDeletedAt) {
    await deleteSavedMessage(row);
  }
}

async function main() {
  requireB2Env();
  const result = await pool.query(
    `SELECT i.id, i."creatorId", i."savedMessageId", i."fileUniqueId", i.kind,
            i."fileName", i.duration, i.width, i.height,
            i."storageKey", i."thumbKey", i."byteSize",
            r.id AS "receiptId", r."savedMessageDeletedAt"
     FROM telegram_vault_items i
     LEFT JOIN telegram_vault_saved_receipts r
       ON r."creatorId" = i."creatorId" AND r."savedMessageId" = i."savedMessageId"
     WHERE i."savedMessageId" IS NOT NULL
       AND (
         i."storageKey" IS NULL
         OR r.id IS NULL
         OR r."savedMessageDeletedAt" IS NULL
       )
     ORDER BY i."createdAt" ASC`
  );
  console.log(`[migrate] ${result.rows.length} Saved Messages vault item(s) to process`);
  let ok = 0;
  let failed = 0;
  for (const row of result.rows) {
    try {
      await migrateOne(row);
      ok += 1;
      console.log(`[migrate] ok ${row.id} savedMessage=${row.savedMessageId}`);
    } catch (err) {
      failed += 1;
      const message = err instanceof TelegramWorkerError || err instanceof Error
        ? err.message
        : String(err);
      console.error(`[migrate] failed ${row.id} savedMessage=${row.savedMessageId}: ${message}`);
    }
  }
  console.log(`[migrate] done ok=${ok} failed=${failed}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[migrate] fatal:', err.message || err);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
