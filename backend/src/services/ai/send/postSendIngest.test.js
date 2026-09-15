const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { latestInboundId, ingestAfterSend } = require('./postSendIngest');

describe('latestInboundId', () => {
  it('returns the newest inbound by sentAt', () => {
    assert.equal(
      latestInboundId([
        {
          direction: 'inbound',
          platformMessageId: 'in-1',
          sentAt: '2026-09-09T12:00:00.000Z',
        },
        {
          direction: 'outbound',
          platformMessageId: 'out-1',
          sentAt: '2026-09-09T12:00:01.000Z',
        },
        {
          direction: 'inbound',
          platformMessageId: 'in-2',
          sentAt: '2026-09-09T12:00:02.000Z',
        },
      ]),
      'in-2'
    );
  });
});

describe('ingestAfterSend', () => {
  it('ingests post_send and skips mark-read when a newer inbound exists', async () => {
    const ingest = [];
    const mark = [];
    const result = await ingestAfterSend(
      {
        platform: 'telegram',
        creatorId: 'cr-1',
        platformChatId: '111',
        answeredInboundId: 'in-1',
      },
      {
        listTelegramMessages: async (_id, peerId, opts) => {
          assert.equal(peerId, '111');
          assert.equal(opts.markRead, false);
          return {
            messages: [
              {
                id: 'in-1',
                isOutgoing: false,
                text: 'hey',
                date: '2026-09-09T12:00:00.000Z',
              },
              {
                id: 'in-2',
                isOutgoing: false,
                text: 'wait',
                date: '2026-09-09T12:00:03.000Z',
              },
            ],
          };
        },
        ingestConversation: async (payload) => {
          ingest.push(payload);
        },
        markTelegramRead: async (...args) => {
          mark.push(args);
        },
        confirmDelayMs: 0,
      }
    );
    assert.equal(result.markedRead, false);
    assert.equal(result.latestInbound, 'in-2');
    assert.equal(ingest[0].source, 'post_send');
    assert.equal(ingest[0].skipProcess, false);
    assert.equal(mark.length, 0);
  });

  it('marks read when the latest inbound is still the answered one', async () => {
    const mark = [];
    const result = await ingestAfterSend(
      {
        platform: 'maloum',
        creatorId: 'cr-1',
        platformChatId: 'chat-1',
        answeredInboundId: 'in-1',
      },
      {
        loadMaloumCreator: async () => ({
          creator: { id: 'cr-1', providerUserId: 'me' },
        }),
        getMaloumMessages: async () => [
          {
            _id: 'in-1',
            senderId: 'fan',
            content: { type: 'text', text: 'hey' },
            sentAt: '2026-09-09T12:00:00.000Z',
          },
        ],
        ingestConversation: async () => {},
        markMaloumRead: async (...args) => {
          mark.push(args);
        },
        confirmDelayMs: 0,
      }
    );
    assert.equal(result.markedRead, true);
    assert.equal(mark.length, 1);
  });

  it('does not mark read when a newer inbound appears on the second fetch', async () => {
    let fetches = 0;
    const ingest = [];
    const mark = [];
    const sleeps = [];
    const result = await ingestAfterSend(
      {
        platform: 'maloum',
        creatorId: 'cr-1',
        platformChatId: 'chat-1',
        answeredInboundId: 'in-1',
      },
      {
        loadMaloumCreator: async () => ({
          creator: { id: 'cr-1', providerUserId: 'me' },
        }),
        getMaloumMessages: async () => {
          fetches += 1;
          const messages = [
            {
              _id: 'in-1',
              senderId: 'fan',
              content: { type: 'text', text: 'hey' },
              sentAt: '2026-09-09T12:00:00.000Z',
            },
          ];
          if (fetches > 1) {
            messages.push({
              _id: 'in-2',
              senderId: 'fan',
              content: { type: 'text', text: 'wait' },
              sentAt: '2026-09-09T12:00:03.000Z',
            });
          }
          return messages;
        },
        ingestConversation: async (payload) => {
          ingest.push(payload);
        },
        markMaloumRead: async (...args) => {
          mark.push(args);
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        confirmDelayMs: 0,
      }
    );
    assert.equal(fetches, 2);
    assert.equal(sleeps.length, 0);
    assert.equal(result.markedRead, false);
    assert.equal(result.latestInbound, 'in-2');
    assert.equal(mark.length, 0);
    assert.equal(ingest.length, 2);
    assert.equal(ingest[1].skipProcess, false);
    assert.ok(
      ingest[1].messages.some((msg) => msg.platformMessageId === 'in-2')
    );
  });

  it('skips mark-read entirely when skipMarkRead is set', async () => {
    const mark = [];
    const result = await ingestAfterSend(
      {
        platform: 'maloum',
        creatorId: 'cr-1',
        platformChatId: 'chat-1',
        answeredInboundId: 'in-1',
        skipMarkRead: true,
      },
      {
        loadMaloumCreator: async () => ({
          creator: { id: 'cr-1', providerUserId: 'me' },
        }),
        getMaloumMessages: async () => [
          {
            _id: 'in-1',
            senderId: 'fan',
            content: { type: 'text', text: 'hey' },
            sentAt: '2026-09-09T12:00:00.000Z',
          },
        ],
        ingestConversation: async () => {},
        markMaloumRead: async (...args) => {
          mark.push(args);
        },
        confirmDelayMs: 0,
      }
    );
    assert.equal(result.markedRead, false);
    assert.equal(mark.length, 0);
  });

  it('fails closed and skips mark-read when refetch throws', async () => {
    const mark = [];
    const result = await ingestAfterSend(
      {
        platform: '4based',
        creatorId: 'cr-1',
        platformChatId: 'chat-1',
        answeredInboundId: 'in-1',
      },
      {
        loadFourBasedCreator: async () => ({
          creator: { id: 'cr-1', providerUserId: 'me' },
        }),
        getFourBasedMessages: async () => {
          throw new Error('network');
        },
        markFourBasedReceived: async (...args) => {
          mark.push(args);
        },
      }
    );
    assert.equal(result.markedRead, false);
    assert.equal(result.error, true);
    assert.equal(mark.length, 0);
  });
});
