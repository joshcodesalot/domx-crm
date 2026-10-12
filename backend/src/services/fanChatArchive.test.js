const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  applyLanguageFields,
  applyInboundTranslation,
  buildSearchText,
  mergeArchiveMessage,
  mapMaloumMessage,
  mapFourBasedMessage,
  mapFanslyMessage,
  mapTelegramMessage,
} = require('./fanChatArchive');

describe('fan chat archive language', () => {
  it('keeps a distinct English draft and the German that was sent', () => {
    const fields = applyLanguageFields({
      direction: 'outbound',
      platform: 'maloum',
      textSent: 'hey schatz',
      englishDraft: 'hey babe',
    });
    assert.equal(fields.textEn, 'hey babe');
    assert.equal(fields.textDe, 'hey schatz');
    assert.equal(fields.textSent, 'hey schatz');
    assert.equal(fields.translationStatus, 'done');
  });

  it('does not invent German when translate is off', () => {
    const fields = applyLanguageFields({
      direction: 'outbound',
      platform: 'telegram',
      textSent: 'hey babe',
      englishDraft: 'hey babe',
    });
    assert.equal(fields.textEn, 'hey babe');
    assert.equal(fields.textDe, null);
    assert.equal(fields.translationStatus, 'skipped');
  });

  it('stores Fansly as English only', () => {
    const fields = applyLanguageFields({
      direction: 'outbound',
      platform: 'fansly',
      textSent: 'hey babe',
      englishDraft: 'hey babe',
    });
    assert.equal(fields.textEn, 'hey babe');
    assert.equal(fields.textDe, null);
    assert.equal(fields.translationStatus, 'skipped');
  });

  it('queues German fan messages for English', () => {
    const fields = applyLanguageFields({
      direction: 'inbound',
      platform: '4based',
      textSent: 'bist du wach',
    });
    assert.equal(fields.textSent, 'bist du wach');
    assert.equal(fields.textEn, null);
    assert.equal(fields.textDe, null);
    assert.equal(fields.translationStatus, 'pending');
  });

  it('keeps Fansly fan text in English', () => {
    const fields = applyLanguageFields({
      direction: 'inbound',
      platform: 'fansly',
      textSent: 'you up?',
    });
    assert.equal(fields.textEn, 'you up?');
    assert.equal(fields.textDe, null);
    assert.equal(fields.translationStatus, 'skipped');
  });

  it('splits a real translation and collapses an unchanged one', () => {
    const changed = applyInboundTranslation('bist du wach', 'are you awake');
    assert.deepEqual(changed, { textEn: 'are you awake', textDe: 'bist du wach' });
    const same = applyInboundTranslation('ok', 'OK');
    assert.deepEqual(same, { textEn: 'ok', textDe: null });
  });

  it('searches each language once', () => {
    assert.equal(buildSearchText('Hey Babe', 'hey schatz', 'hey schatz'), 'hey babe\nhey schatz');
    assert.equal(buildSearchText('hey', 'hey', 'hey'), 'hey');
  });
});

describe('fan chat archive merge', () => {
  it('does not replace a finished translation with a later history row', () => {
    const merged = mergeArchiveMessage(
      {
        chatterId: 'chatter-1',
        chatterName: 'Mia',
        translationStatus: 'done',
        textEn: 'hey babe',
        textDe: 'hey schatz',
        textSent: 'hey schatz',
        kind: 'dm',
        hasMedia: false,
        isPpv: false,
        deletedAt: null,
      },
      {
        platformMessageId: 'm1',
        direction: 'outbound',
        senderRole: 'creator',
        chatterId: null,
        chatterName: null,
        kind: 'dm',
        textSent: 'hey schatz',
        textEn: 'hey schatz',
        textDe: null,
        translationStatus: 'skipped',
        hasMedia: false,
        isPpv: false,
        priceNet: null,
        currency: null,
        mediaJson: null,
        sentAt: '2026-10-12T00:00:00.000Z',
        deletedAt: null,
        searchText: 'hey schatz',
      }
    );
    assert.equal(merged.chatterId, 'chatter-1');
    assert.equal(merged.chatterName, 'Mia');
    assert.equal(merged.textEn, 'hey babe');
    assert.equal(merged.textDe, 'hey schatz');
    assert.equal(merged.translationStatus, 'done');
    assert.equal(merged.searchText, 'hey babe\nhey schatz');
  });

  it('lets a send fill the chatter after history was stored', () => {
    const merged = mergeArchiveMessage(
      {
        chatterId: null,
        chatterName: null,
        translationStatus: 'pending',
        textEn: null,
        textDe: null,
        textSent: 'bist du wach',
        kind: 'dm',
        hasMedia: false,
        isPpv: false,
        deletedAt: null,
      },
      {
        platformMessageId: 'm2',
        direction: 'outbound',
        senderRole: 'creator',
        chatterId: 'chatter-2',
        chatterName: 'Noah',
        kind: 'ppv',
        textSent: 'nur für dich',
        textEn: 'just for you',
        textDe: 'nur für dich',
        translationStatus: 'done',
        hasMedia: true,
        isPpv: true,
        priceNet: 15,
        currency: 'EUR',
        mediaJson: null,
        sentAt: '2026-10-12T00:00:00.000Z',
        deletedAt: null,
        searchText: '',
      }
    );
    assert.equal(merged.chatterId, 'chatter-2');
    assert.equal(merged.textEn, 'just for you');
    assert.equal(merged.kind, 'ppv');
    assert.equal(merged.translationStatus, 'done');
  });
});

describe('fan chat archive mappers', () => {
  it('maps Maloum broadcast and priced messages', () => {
    const broadcast = mapMaloumMessage(
      {
        _id: 'a',
        senderId: 'creator',
        isBroadcasted: true,
        sentAt: '2026-10-12T00:00:00.000Z',
        content: { text: 'mass hello' },
      },
      { providerUserId: 'creator' }
    );
    assert.equal(broadcast.direction, 'outbound');
    assert.equal(broadcast.kind, 'mass');

    const ppv = mapMaloumMessage(
      {
        _id: 'b',
        senderId: 'fan',
        content: { text: 'bought', price: { net: 12, currency: 'EUR' }, media: [{ id: 'm', type: 'picture' }] },
      },
      { providerUserId: 'creator' }
    );
    assert.equal(ppv.direction, 'inbound');
    assert.equal(ppv.kind, 'ppv');
    assert.equal(ppv.priceNet, 12);
    assert.equal(ppv.hasMedia, true);
  });

  it('maps 4based sender and coin price', () => {
    const row = mapFourBasedMessage(
      {
        _id: 'c',
        user_id: 'creator',
        message: 'schau',
        created_at: '2026-10-12T00:00:00.000Z',
        file_stack_id: 'stack',
        file_stack: { price: 1210 },
      },
      { providerUserId: 'creator' }
    );
    assert.equal(row.direction, 'outbound');
    assert.equal(row.kind, 'ppv');
    assert.equal(row.priceNet, 10);
    assert.equal(row.textSent, 'schau');
  });

  it('maps Fansly locked text and deletes', () => {
    const row = mapFanslyMessage(
      {
        id: '9',
        senderId: 'fan',
        content: 'open this',
        createdAt: 1760000000,
        deletedAt: 1760000100,
        lockedText: [{ content: 'secret line', price: 5 }],
        media: [],
      },
      { providerUserId: 'creator' }
    );
    assert.equal(row.direction, 'inbound');
    assert.equal(row.textSent, 'open this\nsecret line');
    assert.equal(row.kind, 'ppv');
    assert.equal(row.skipTranslation, true);
    assert.ok(row.deletedAt);
  });

  it('does not translate Telegram media placeholders', () => {
    const row = mapTelegramMessage({
      id: '4',
      isOutgoing: false,
      text: '',
      placeholder: 'Photo',
      hasMedia: true,
      kind: 'photo',
      date: '2026-10-12T00:00:00.000Z',
    });
    assert.equal(row.textSent, 'Photo');
    assert.equal(row.skipTranslation, true);
    assert.equal(row.direction, 'inbound');
  });
});

describe('chat archive route', () => {
  it('reads stored rows and does not call platform clients', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/chatArchive.js'), 'utf8');
    for (const token of ['maloumClient', 'fourBasedClient', 'fanslyClient', 'telegramWorker']) {
      assert.equal(route.includes(token), false, `chatArchive.js references ${token}`);
    }
    assert.equal(route.includes('fan_messages'), true);
    assert.equal(route.includes('requireOwnerOrManager'), true);
  });
});
