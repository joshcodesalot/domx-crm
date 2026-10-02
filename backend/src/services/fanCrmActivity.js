const { randomUUID } = require('crypto');
const pool = require('../db/pool');

const ACTIONS = new Set([
  'rename',
  'note_add',
  'note_remove',
  'note_edit',
  'list_add',
  'list_remove',
  'list_bulk_add',
]);

const PLATFORMS = new Set(['maloum', '4based', 'telegram']);
const VALUE_MAX = 4000;
const LABEL_MAX = 200;

function clip(value, max) {
  const text = value == null ? '' : String(value);
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function textValue(value) {
  return typeof value === 'string' ? value : '';
}

function actorFrom(user) {
  return {
    chatterId: user?.id || null,
    chatterName: clip(user?.name || 'Staff', 255),
  };
}

function noteAction(previous, next) {
  const prev = textValue(previous);
  const nxt = textValue(next);
  if (prev === nxt) return null;
  const prevHasText = prev.trim().length > 0;
  const nextHasText = nxt.trim().length > 0;
  if (!prevHasText && !nextHasText) return null;
  if (!prevHasText && nextHasText) return 'note_add';
  if (prevHasText && !nextHasText) return 'note_remove';
  return 'note_edit';
}

function extractMaloumFan(chat) {
  const empty = { fanId: '', fanLabel: '', nickname: '', notes: '' };
  if (!chat || typeof chat !== 'object') return empty;
  const root =
    chat.chatPartner || !chat.data || typeof chat.data !== 'object' ? chat : chat.data;
  const partner = root.chatPartner;
  if (!partner || typeof partner !== 'object') return empty;
  const fanId = partner._id ? String(partner._id) : '';
  const username = textValue(partner.username);
  const nickname = textValue(partner.nickname);
  const notes = textValue(partner.notes);
  return {
    fanId,
    fanLabel: username || nickname,
    nickname,
    notes,
  };
}

function normalizeListEntries(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.lists)
        ? payload.lists
        : [];
  const entries = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) entries.push({ id, name: '' });
      continue;
    }
    const id = String(item._id || item.id || '').trim();
    if (!id) continue;
    entries.push({
      id,
      name: textValue(item.name).trim(),
    });
  }
  return entries;
}

function membershipChanges(before, after) {
  const beforeMap = new Map(before.map((item) => [item.id, item.name || '']));
  const afterMap = new Map(after.map((item) => [item.id, item.name || '']));
  const added = [];
  const removed = [];
  for (const [id, name] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push({ id, name });
    }
  }
  for (const [id, name] of beforeMap) {
    if (!afterMap.has(id)) {
      removed.push({ id, name });
    }
  }
  return { added, removed };
}

function listChangeEvents(base, added, removed) {
  return [
    ...added.map((item) => ({
      ...base,
      action: 'list_add',
      listId: item.id,
      listName: item.name || '',
      previousValue: '',
      nextValue: item.name || item.id,
    })),
    ...removed.map((item) => ({
      ...base,
      action: 'list_remove',
      listId: item.id,
      listName: item.name || '',
      previousValue: item.name || item.id,
      nextValue: '',
    })),
  ];
}

async function lookupFanLabel(creatorId, fanId) {
  if (!creatorId || !fanId) return '';
  const result = await pool.query(
    `SELECT "fanUsername"
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND "fanId" = $2
       AND COALESCE("fanUsername", '') <> ''
     ORDER BY "sentAt" DESC
     LIMIT 1`,
    [creatorId, fanId]
  );
  return textValue(result.rows[0]?.fanUsername).trim();
}

async function recordFanCrmEvents(events) {
  const rows = Array.isArray(events) ? events.filter(Boolean) : [];
  if (rows.length === 0) return;
  for (const event of rows) {
    if (!PLATFORMS.has(event.platform) || !ACTIONS.has(event.action)) continue;
    if (!event.creatorId) continue;
    try {
      let fanLabel = textValue(event.fanLabel).trim();
      if (!fanLabel && event.fanId) {
        fanLabel = await lookupFanLabel(event.creatorId, event.fanId);
      }
      await pool.query(
        `INSERT INTO fan_crm_events (
           id, "chatterId", "chatterName", "creatorId", platform,
           "fanId", "fanLabel", "chatId", action,
           "previousValue", "nextValue", "listId", "listName"
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13
         )`,
        [
          randomUUID(),
          event.chatterId || null,
          clip(event.chatterName || 'Staff', 255),
          event.creatorId,
          event.platform,
          clip(event.fanId || '', 200),
          clip(fanLabel, LABEL_MAX),
          event.chatId ? clip(event.chatId, 200) : null,
          event.action,
          clip(event.previousValue || '', VALUE_MAX),
          clip(event.nextValue || '', VALUE_MAX),
          event.listId ? clip(event.listId, 200) : null,
          clip(event.listName || '', LABEL_MAX),
        ]
      );
    } catch (err) {
      console.error('fan crm activity log failed:', err);
    }
  }
}

module.exports = {
  ACTIONS,
  actorFrom,
  textValue,
  noteAction,
  extractMaloumFan,
  normalizeListEntries,
  membershipChanges,
  listChangeEvents,
  recordFanCrmEvents,
};
