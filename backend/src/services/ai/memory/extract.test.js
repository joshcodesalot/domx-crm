const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { emptyMemory } = require('../memory');
const {
  normalizeExtracted,
  mergeAiNotesBlock,
  buildAiNotesBlock,
  applyFanNotesTemplate,
  ensureTriggerInbound,
  extractAndSyncFanMemory,
  AI_NOTES_MARKER,
  DEFAULT_FAN_NOTES_TEMPLATE,
} = require('./extract');

describe('memory extract helpers', () => {
  it('does not treat username as givenName', () => {
    const extracted = normalizeExtracted(
      {
        givenName: 'sugar_daddy99',
        facts: [{ kind: 'name', text: 'sugar_daddy99' }],
      },
      { username: 'sugar_daddy99' }
    );
    assert.equal(extracted.givenName, null);
  });

  it('does not treat an opaque username like u82091749y as givenName', () => {
    const extracted = normalizeExtracted(
      { givenName: 'u82091749y', facts: [] },
      { username: 'u82091749y' }
    );
    assert.equal(extracted.givenName, null);
  });

  it('fills Fetishes / Kinks on the template and keeps other lines', () => {
    const filled = applyFanNotesTemplate('', {
      givenName: 'Franz',
      facts: [
        { kind: 'preference', text: 'c2c' },
        { kind: 'preference', text: 'thick tits' },
      ],
    });
    const kinksLine = filled
      .split('\n')
      .find((line) => /Fetishes \/ Kinks:/i.test(line));
    assert.ok(kinksLine);
    assert.match(kinksLine, /c2c/);
    assert.match(kinksLine, /thick tits/);
    assert.match(filled, /Experience Level:/);
    assert.match(filled, /Hard Limits:/);
    assert.match(filled, new RegExp(AI_NOTES_MARKER));
    assert.match(filled, /Name: Franz/);
    assert.equal(/\nKinks:/m.test(filled), false);
  });

  it('preserves chatter text when filling the kinks line', () => {
    const filled = applyFanNotesTemplate(
      `Likes late chats\n\n${DEFAULT_FAN_NOTES_TEMPLATE}`,
      { facts: [{ kind: 'preference', text: 'c2c' }] }
    );
    assert.match(filled, /Likes late chats/);
    assert.match(filled, /Fetishes \/ Kinks:.*c2c/i);
  });

  it('appends an AI notes block without wiping chatter notes', () => {
    const block = buildAiNotesBlock({
      givenName: 'Alex',
      facts: [{ kind: 'spend', text: 'bought PPV' }],
    });
    assert.match(block, new RegExp(AI_NOTES_MARKER));
    const merged = mergeAiNotesBlock('Likes late chats', block);
    assert.match(merged, /Likes late chats/);
    assert.match(merged, /Name: Alex/);
    const replaced = mergeAiNotesBlock(
      merged,
      `${AI_NOTES_MARKER}\nName: Alex\nSpend: leather`
    );
    assert.equal(replaced.startsWith('Likes late chats'), true);
    assert.match(replaced, /leather/);
    assert.equal((replaced.match(new RegExp(AI_NOTES_MARKER, 'g')) || []).length, 1);
  });

  it('appends a missing trigger inbound before extract', async () => {
    const messages = await ensureTriggerInbound(
      [{ platformMessageId: 'in-2', direction: 'inbound', text: 'dicke Titten' }],
      {
        conversationId: 'conv-1',
        inboundPlatformMessageId: 'in-franz',
        loadTriggerInbound: async () => ({
          platformMessageId: 'in-franz',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'Hey ich bin Franz und steh leider auf c2c',
        }),
      }
    );
    assert.equal(
      messages.some((msg) => msg.platformMessageId === 'in-franz'),
      true
    );
    assert.match(messages[messages.length - 1].text, /ich bin Franz/);
  });
});

describe('extractAndSyncFanMemory', () => {
  it('writes Franz nickname and fills kinks from the trigger inbound', async () => {
    const nicknameCalls = [];
    const notesCalls = [];
    const extractCalls = [];
    const emitCalls = [];
    const result = await extractAndSyncFanMemory(
      {
        conversation: {
          id: 'conv-1',
          platformFanId: 'fan-1',
          platformChatId: 'chat-1',
          fanUsername: 'u82091749y',
        },
        creatorId: 'cr-1',
        platform: 'maloum',
        inboundPlatformMessageId: 'in-franz',
        messages: [
          {
            platformMessageId: 'in-2',
            direction: 'inbound',
            senderRole: 'fan',
            text: 'dicke Titten',
          },
        ],
      },
      {
        getFanMemory: async () =>
          emptyMemory({
            creatorId: 'cr-1',
            platform: 'maloum',
            platformFanId: 'fan-1',
          }),
        upsertFanMemory: async (row) => row,
        extractFanFacts: async ({ messages }) => {
          extractCalls.push(messages);
          return {
            givenName: 'Franz',
            facts: [
              { kind: 'preference', text: 'c2c' },
              { kind: 'preference', text: 'thick tits' },
            ],
          };
        },
        loadTriggerInbound: async () => ({
          platformMessageId: 'in-franz',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'Hey ich bin Franz und steh leider auf c2c',
        }),
        loadMaloumCreator: async () => ({ creator: { id: 'cr-1' } }),
        updateFanNickname: async (_creator, chatId, nickname) => {
          nicknameCalls.push({ chatId, nickname });
        },
        getChat: async () => ({ chatPartner: { notes: '' } }),
        updateFanNotes: async (_creator, _chatId, notes) => {
          notesCalls.push(notes);
        },
        emitFanMemoryEvent: async (payload) => {
          emitCalls.push(payload);
          return { emitted: true };
        },
      }
    );

    assert.equal(result.givenName, 'Franz');
    assert.equal(nicknameCalls.length, 1);
    assert.equal(nicknameCalls[0].nickname, 'Franz');
    assert.equal(
      nicknameCalls.some((call) => call.nickname === 'u82091749y'),
      false
    );
    assert.match(extractCalls[0].map((msg) => msg.text).join('\n'), /ich bin Franz/);
    assert.match(notesCalls[0], /Fetishes \/ Kinks:.*c2c/i);
    assert.match(notesCalls[0], /Experience Level:/);
    assert.equal(emitCalls[0].nickname, 'Franz');
    assert.match(emitCalls[0].notes, /c2c/);
  });
});
