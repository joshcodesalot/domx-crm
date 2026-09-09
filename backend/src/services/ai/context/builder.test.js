const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAiContext, CONTEXT_MESSAGE_LIMIT } = require('./builder');

function message(index, extras = {}) {
  return {
    platformMessageId: `m${index}`,
    direction: index % 2 === 0 ? 'inbound' : 'outbound',
    senderRole: index % 2 === 0 ? 'fan' : 'creator',
    text: `msg ${index}`,
    sentAt: new Date(Date.UTC(2026, 8, 9, 12, index, 0)).toISOString(),
    ...extras,
  };
}

describe('buildAiContext', () => {
  it('caps messages at the newest 20', () => {
    const messages = Array.from({ length: 25 }, (_, i) => message(i));
    const dto = buildAiContext({
      conversation: { id: 'c1', creatorId: 'cr1', platform: 'maloum', revision: 2 },
      messages,
    });
    assert.equal(dto.messages.length, CONTEXT_MESSAGE_LIMIT);
    assert.equal(dto.messages[0].platformMessageId, 'm5');
    assert.equal(dto.messages[19].platformMessageId, 'm24');
  });

  it('is safe with an empty profile', () => {
    const dto = buildAiContext({
      conversation: { id: 'c1', creatorId: 'cr1', platform: 'maloum' },
      messages: [],
      profile: null,
    });
    assert.equal(dto.profileVersion, 0);
    assert.equal(dto.profile.persona, '');
    assert.deepEqual(dto.profile.languages, []);
    assert.ok(Array.isArray(dto.constraints));
    assert.equal(dto.lastSessionSummary, null);
    assert.deepEqual(dto.fan.memories, []);
    assert.equal(dto.conversationState, 'NEW');
    assert.deepEqual(dto.mediaCandidates, []);
    assert.deepEqual(dto.rules, []);
  });

  it('includes approved rules without secrets', () => {
    const dto = buildAiContext({
      conversation: { id: 'c1', creatorId: 'cr1', platform: 'maloum' },
      messages: [message(0)],
      rules: [
        { scope: 'CREATOR', text: 'Stay in character', password: 'SECRET' },
        { scope: 'NOPE', text: 'drop me' },
      ],
    });
    assert.deepEqual(dto.rules, [{ scope: 'CREATOR', text: 'Stay in character' }]);
    assert.equal(JSON.stringify(dto).includes('SECRET'), false);
  });

  it('includes mediaCandidates without previewUrl', () => {
    const dto = buildAiContext({
      conversation: { id: 'c1', creatorId: 'cr1', platform: 'maloum' },
      messages: [message(0)],
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
          previewUrl: 'https://cdn.example/secret',
        },
      ],
    });
    assert.equal(dto.mediaCandidates.length, 1);
    assert.equal(dto.mediaCandidates[0].mediaId, 'up-1');
    assert.equal(Object.hasOwn(dto.mediaCandidates[0], 'previewUrl'), false);
  });

  it('includes conversationState from the conversation row', () => {
    const dto = buildAiContext({
      conversation: {
        id: 'c1',
        creatorId: 'cr1',
        platform: 'maloum',
        state: 'WARMUP',
      },
      messages: [message(0)],
    });
    assert.equal(dto.conversationState, 'WARMUP');
  });

  it('passes lastSessionSummary through with the last 20 messages', () => {
    const messages = Array.from({ length: 25 }, (_, i) => message(i));
    const dto = buildAiContext({
      conversation: { id: 'c1', creatorId: 'cr1', platform: 'maloum', revision: 2 },
      messages,
      lastSessionSummary: '  Previous session: fan said hi  ',
    });
    assert.equal(dto.lastSessionSummary, 'Previous session: fan said hi');
    assert.equal(dto.messages.length, CONTEXT_MESSAGE_LIMIT);
    assert.equal(dto.messages[0].platformMessageId, 'm5');
    assert.equal(dto.messages[19].platformMessageId, 'm24');
  });

  it('includes fan memories and prefers request notes', () => {
    const dto = buildAiContext({
      conversation: {
        id: 'c1',
        creatorId: 'cr1',
        platform: 'maloum',
        platformFanId: 'fan-1',
      },
      messages: [message(0)],
      fanNotes: 'lives nearby',
      fanNickname: 'Alex',
      fanMemories: [
        { kind: 'preference', text: 'likes voice notes' },
        { kind: 'boundary', text: 'no calls' },
      ],
    });
    assert.equal(dto.fan.nickname, 'Alex');
    assert.equal(dto.fan.notes, 'lives nearby');
    assert.equal(dto.fan.platformFanId, 'fan-1');
    assert.deepEqual(dto.fan.memories, [
      { kind: 'preference', text: 'likes voice notes' },
      { kind: 'boundary', text: 'no calls' },
    ]);
  });

  it('does not leak secrets from conversation or profile', () => {
    const dto = buildAiContext({
      conversation: {
        id: 'c1',
        creatorId: 'cr1',
        platform: 'maloum',
        encryptedLoginPassword: 'SECRET_PASSWORD',
        accessToken: 'SECRET_TOKEN',
        proxy: 'http://secret-proxy:8080',
        customProxy: 'socks5://hidden',
      },
      profile: {
        persona: 'Naomi',
        encryptedLoginPassword: 'SECRET_PASSWORD',
        accessToken: 'SECRET_TOKEN',
        proxy: 'http://secret-proxy:8080',
        token: 'SECRET_TOKEN',
        password: 'SECRET_PASSWORD',
      },
      fanMemories: [
        {
          kind: 'other',
          text: 'safe fact',
          password: 'SECRET_PASSWORD',
          accessToken: 'SECRET_TOKEN',
        },
      ],
      messages: [message(0)],
    });

    const dumped = JSON.stringify(dto);
    assert.equal(dumped.includes('SECRET_PASSWORD'), false);
    assert.equal(dumped.includes('SECRET_TOKEN'), false);
    assert.equal(dumped.includes('secret-proxy'), false);
    assert.equal(dumped.includes('encryptedLoginPassword'), false);
    assert.equal(dumped.includes('accessToken'), false);
    assert.equal(Object.hasOwn(dto, 'encryptedLoginPassword'), false);
    assert.equal(Object.hasOwn(dto.profile, 'proxy'), false);
    assert.equal(dto.profile.persona, 'Naomi');
  });
});
