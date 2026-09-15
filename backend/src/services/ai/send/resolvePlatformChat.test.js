const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isChatNotFoundError,
  extractChatId,
  resolvePlatformChat,
  persistResolvedChatId,
  resetDeadChatSkips,
} = require('./resolvePlatformChat');

describe('isChatNotFoundError', () => {
  beforeEach(() => {
    resetDeadChatSkips();
  });

  it('matches HTTP 404 and Chat cannot be found', () => {
    assert.equal(isChatNotFoundError({ status: 404, message: 'nope' }), true);
    assert.equal(
      isChatNotFoundError({ status: 400, message: 'Chat cannot be found' }),
      true
    );
    assert.equal(isChatNotFoundError({ status: 500, message: 'timeout' }), false);
  });
});

describe('extractChatId', () => {
  it('reads _id, nested chat, and id', () => {
    assert.equal(extractChatId({ _id: 'c1' }), 'c1');
    assert.equal(extractChatId({ chat: { _id: 'c2' } }), 'c2');
    assert.equal(extractChatId({ id: 99 }), '99');
  });
});

describe('resolvePlatformChat', () => {
  it('Maloum getChat miss then createChat(fanId)', async () => {
    const created = [];
    const result = await resolvePlatformChat(
      {
        platform: 'maloum',
        creator: { id: 'cr-1' },
        platformChatId: 'stale',
        platformFanId: 'fan-1',
      },
      {
        getChat: async () => {
          const err = new Error('Chat cannot be found');
          err.status = 404;
          throw err;
        },
        createChat: async (_creator, fanId) => {
          created.push(fanId);
          return { chat: { _id: 'fresh' } };
        },
      }
    );
    assert.deepEqual(created, ['fan-1']);
    assert.equal(result.platformChatId, 'fresh');
    assert.equal(result.source, 'createChat');
  });

  it('4based createChatByUser after getChatByUser 404', async () => {
    const result = await resolvePlatformChat(
      {
        platform: '4based',
        creator: { id: 'cr-1' },
        platformChatId: 'stale',
        platformFanId: 'fan-9',
      },
      {
        getChatByUser: async () => {
          const err = new Error('missing');
          err.status = 404;
          throw err;
        },
        createChatByUser: async () => ({ _id: 'fb-fresh' }),
      }
    );
    assert.equal(result.platformChatId, 'fb-fresh');
    assert.equal(result.source, 'createChatByUser');
  });
});

describe('persistResolvedChatId', () => {
  it('updates conversation and suggestion when the chat id is free', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('UPDATE ai_conversations')) {
          return {
            rows: [{ id: params[0], platformChatId: params[1] }],
          };
        }
        if (sql.includes('UPDATE ai_suggestions')) {
          return {
            rows: [
              {
                id: params[0],
                platformChatId: params[1],
                conversationId: params[2],
              },
            ],
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
    const result = await persistResolvedChatId({
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'stale',
      },
      suggestion: { id: 'sug-1', platformChatId: 'stale' },
      newChatId: 'fresh',
      client,
    });
    assert.equal(result.platformChatId, 'fresh');
    assert.equal(result.conversation.platformChatId, 'fresh');
    assert.equal(result.suggestion.platformChatId, 'fresh');
    assert.equal(queries.length, 2);
  });

  it('merges onto the existing row on unique conflict', async () => {
    const client = {
      async query(sql, params) {
        if (sql.includes('UPDATE ai_suggestions')) {
          return {
            rows: [
              {
                id: params[0],
                platformChatId: params[1],
                conversationId: params[2],
              },
            ],
          };
        }
        if (sql.includes('SET "platformChatId"')) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        if (sql.includes('"creatorId"') && sql.includes('"platformChatId"')) {
          return {
            rows: [
              {
                id: 'conv-existing',
                creatorId: 'cr-1',
                platform: 'maloum',
                platformChatId: 'fresh',
                revision: 1,
                lastInboundPlatformMessageId: 'in-old',
                lastInboundAt: '2026-09-09T10:00:00.000Z',
                lastMessageAt: '2026-09-09T10:00:00.000Z',
                platformFanId: null,
              },
            ],
          };
        }
        if (sql.includes('SELECT * FROM ai_conversations WHERE id')) {
          return {
            rows: [
              {
                id: 'conv-existing',
                creatorId: 'cr-1',
                platform: 'maloum',
                platformChatId: 'fresh',
                revision: 1,
                lastInboundPlatformMessageId: 'in-old',
                lastInboundAt: '2026-09-09T10:00:00.000Z',
                lastMessageAt: '2026-09-09T10:00:00.000Z',
                platformFanId: null,
              },
            ],
          };
        }
        if (sql.includes('SET "platformFanId"')) {
          return {
            rows: [
              {
                id: 'conv-existing',
                platformChatId: 'fresh',
                revision: 4,
                lastInboundPlatformMessageId: 'in-new',
                lastInboundAt: params[5],
                lastMessageAt: params[6],
                platformFanId: params[2],
              },
            ],
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
    const result = await persistResolvedChatId({
      conversation: {
        id: 'conv-stale',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'stale',
        platformFanId: 'fan-1',
        revision: 4,
        lastInboundPlatformMessageId: 'in-new',
        lastInboundAt: '2026-09-09T13:00:00.000Z',
        lastMessageAt: '2026-09-09T13:00:00.000Z',
      },
      suggestion: { id: 'sug-1', platformChatId: 'stale', conversationId: 'conv-stale' },
      newChatId: 'fresh',
      client,
    });
    assert.equal(result.platformChatId, 'fresh');
    assert.equal(result.conversation.id, 'conv-existing');
    assert.equal(result.suggestion.conversationId, 'conv-existing');
    assert.equal(result.suggestion.platformChatId, 'fresh');
    assert.equal(result.conversation.lastInboundPlatformMessageId, 'in-new');
  });
});
