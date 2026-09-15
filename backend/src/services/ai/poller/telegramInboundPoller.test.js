const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  selectEligibleCreators,
  mapTelegramMessagesForIngest,
  resetPollerBackoff,
  stopTelegramInboundPoller,
  tick,
  isBackedOff,
  DIALOG_LIMIT,
} = require('./telegramInboundPoller');
const { isTelegramServiceDialog } = require('../../telegramWorker');

const ON_FLAGS = {
  enabled: true,
  shadowAllowed: true,
  suggestAllowed: true,
  autoSendAllowed: false,
};

const ELIGIBLE_ROW = {
  id: 'cr-1',
  platform: 'telegram',
  connectionStatus: 'connected',
  mode: MODES.SHADOW,
  paused: false,
};

describe('selectEligibleCreators', () => {
  beforeEach(() => {
    resetPollerBackoff();
    stopTelegramInboundPoller();
  });

  it('keeps eligible connected telegram creators', () => {
    const rows = [
      ELIGIBLE_ROW,
      {
        id: 'off-1',
        platform: 'telegram',
        connectionStatus: 'connected',
        mode: MODES.OFF,
        paused: false,
      },
      {
        id: 'maloum-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
    ];
    assert.deepEqual(
      selectEligibleCreators(rows, ON_FLAGS).map((row) => row.id),
      ['cr-1']
    );
  });
});

describe('mapTelegramMessagesForIngest', () => {
  it('skips deleted and maps outgoing as creator', () => {
    const mapped = mapTelegramMessagesForIngest([
      { id: '1', isOutgoing: true, text: 'hi', date: '2026-09-09T00:00:00.000Z' },
      { id: '2', isOutgoing: false, text: 'hey', date: '2026-09-09T00:01:00.000Z' },
      { id: '3', deleted: true, text: 'gone' },
    ]);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].direction, 'outbound');
    assert.equal(mapped[1].direction, 'inbound');
    assert.equal(mapped[1].isPpv, false);
  });
});

describe('tick', () => {
  beforeEach(() => {
    resetPollerBackoff();
    stopTelegramInboundPoller();
  });

  it('ingests dialogs with unreadCount > 0', async () => {
    const ingest = [];
    const listed = [];
    const result = await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      listDialogs: async (_id, opts) => {
        listed.push(opts);
        return [
          { peerId: '111', unreadCount: 2, displayName: 'Fan' },
          { peerId: '222', unreadCount: 0, displayName: 'Quiet' },
        ];
      },
      listMessages: async (_id, peerId, opts) => {
        listed.push({ peerId, opts });
        return {
          messages: [
            {
              id: 'm1',
              isOutgoing: false,
              text: 'hi',
              date: '2026-09-09T00:00:00.000Z',
            },
          ],
        };
      },
      listRecentConversations: async () => [],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(result.polled, 1);
    assert.deepEqual(listed[0], { limit: DIALOG_LIMIT });
    assert.deepEqual(listed[1], {
      peerId: '111',
      opts: { limit: 15, markRead: false },
    });
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].platform, 'telegram');
    assert.equal(ingest[0].platformChatId, '111');
    assert.equal(ingest[0].platformFanId, '111');
    assert.equal(ingest[0].source, 'poll');
    assert.equal(ingest[0].messages[0].platformMessageId, 'm1');
  });

  it('skips dialogs with unreadCount 0', async () => {
    let messageCalls = 0;
    const ingest = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      listDialogs: async () => [{ peerId: '222', unreadCount: 0 }],
      listMessages: async () => {
        messageCalls += 1;
        return { messages: [] };
      },
      listRecentConversations: async () => [],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(messageCalls, 0);
    assert.equal(ingest.length, 0);
  });

  it('skips Telegram service dialogs', async () => {
    let messageCalls = 0;
    const ingest = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      listDialogs: async () => [
        { peerId: '777000', unreadCount: 4, displayName: 'Telegram' },
        { peerId: '42777', unreadCount: 3, displayName: 'Telegram' },
      ],
      listMessages: async () => {
        messageCalls += 1;
        return { messages: [] };
      },
      listRecentConversations: async () => [],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(messageCalls, 0);
    assert.equal(ingest.length, 0);
  });

  it('re-checks recently active unread-0 chats with markRead false', async () => {
    const ingest = [];
    const messageOpts = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      listDialogs: async () => [{ peerId: '222', unreadCount: 0 }],
      listMessages: async (_id, peerId, opts) => {
        messageOpts.push({ peerId, opts });
        return {
          messages: [
            {
              id: 'm2',
              isOutgoing: false,
              text: 'follow up',
              date: '2026-09-09T00:02:00.000Z',
            },
          ],
        };
      },
      listRecentConversations: async ({ skipChatIds }) => {
        assert.deepEqual(skipChatIds, []);
        return [
          {
            platformChatId: '333',
            platformFanId: '333',
            fanUsername: 'fastfan',
          },
        ];
      },
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(messageOpts.length, 1);
    assert.equal(messageOpts[0].peerId, '333');
    assert.deepEqual(messageOpts[0].opts, { limit: 15, markRead: false });
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].source, 'recent_active');
    assert.equal(ingest[0].platformChatId, '333');
    assert.equal(ingest[0].messages[0].platformMessageId, 'm2');
  });

  it('keeps polling other chats when one listMessages throws', async () => {
    const ingest = [];
    const now = 5_000;
    const result = await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      listDialogs: async () => [
        { peerId: 'dead', unreadCount: 1 },
        { peerId: 'alive', unreadCount: 1 },
      ],
      listMessages: async (_id, peerId, opts) => {
        assert.equal(opts.markRead, false);
        if (peerId === 'dead') {
          throw new Error('PEER_ID_INVALID');
        }
        return {
          messages: [
            {
              id: 'm1',
              isOutgoing: false,
              text: 'hi',
              date: '2026-09-09T00:00:00.000Z',
            },
          ],
        };
      },
      listRecentConversations: async () => [],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
      now: () => now,
    });
    assert.equal(result.polled, 1);
    assert.equal(isBackedOff('cr-1', now + 1), false);
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].platformChatId, 'alive');
  });
});
