const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  selectEligibleCreators,
  mapMaloumMessagesForIngest,
  resetPollerBackoff,
  stopMaloumInboundPoller,
  tick,
  isBackedOff,
} = require('./maloumInboundPoller');
const { resetDeadChatSkips } = require('../send/resolvePlatformChat');

const ON_FLAGS = {
  enabled: true,
  shadowAllowed: true,
  suggestAllowed: true,
  autoSendAllowed: false,
};

describe('selectEligibleCreators', () => {
  beforeEach(() => {
    resetPollerBackoff();
  });

  it('drops off, disconnected, paused, and effective-off creators', () => {
    const rows = [
      {
        id: 'off-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.OFF,
        paused: false,
      },
      {
        id: 'disc-1',
        platform: 'maloum',
        connectionStatus: 'disconnected',
        mode: MODES.SHADOW,
        paused: false,
      },
      {
        id: 'paused-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SUGGEST_ONLY,
        paused: true,
      },
      {
        id: 'telegram-1',
        platform: 'telegram',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
      {
        id: 'shadow-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
      {
        id: 'suggest-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SUGGEST_ONLY,
        paused: false,
      },
    ];

    const eligible = selectEligibleCreators(rows, ON_FLAGS);
    assert.deepEqual(
      eligible.map((row) => row.id),
      ['shadow-1', 'suggest-1']
    );
  });

  it('returns none when global AI is off', () => {
    const rows = [
      {
        id: 'shadow-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
    ];
    assert.deepEqual(
      selectEligibleCreators(rows, { ...ON_FLAGS, enabled: false }),
      []
    );
  });

  it('drops shadow when shadow is not allowed', () => {
    const rows = [
      {
        id: 'shadow-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
    ];
    assert.deepEqual(
      selectEligibleCreators(rows, { ...ON_FLAGS, shadowAllowed: false }),
      []
    );
  });

  it('includes auto_low_risk and auto when auto-send is allowed', () => {
    const rows = [
      {
        id: 'low-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.AUTO_LOW_RISK,
        paused: false,
      },
      {
        id: 'auto-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.AUTO,
        paused: false,
      },
      {
        id: 'off-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.OFF,
        paused: false,
      },
    ];
    const eligible = selectEligibleCreators(rows, {
      ...ON_FLAGS,
      autoSendAllowed: true,
    });
    assert.deepEqual(
      eligible.map((row) => row.id),
      ['low-1', 'auto-1']
    );
  });
});

describe('mapMaloumMessagesForIngest', () => {
  it('marks creator messages outbound', () => {
    const mapped = mapMaloumMessagesForIngest(
      [
        {
          _id: 'm1',
          senderId: 'me',
          content: { type: 'text', text: 'hi' },
          sentAt: '2026-09-09T00:00:00.000Z',
        },
        {
          _id: 'm2',
          senderId: 'fan',
          content: { type: 'text', text: 'hey' },
          sentAt: '2026-09-09T00:01:00.000Z',
        },
      ],
      'me'
    );
    assert.equal(mapped[0].direction, 'outbound');
    assert.equal(mapped[1].direction, 'inbound');
    assert.equal(mapped[1].platformMessageId, 'm2');
  });
});

const ELIGIBLE_ROW = {
  id: 'cr-1',
  platform: 'maloum',
  connectionStatus: 'connected',
  mode: MODES.SHADOW,
  paused: false,
};

describe('tick', () => {
  beforeEach(() => {
    resetPollerBackoff();
    resetDeadChatSkips();
    stopMaloumInboundPoller();
  });

  it('re-checks recently active unread-0 chats without mark-read', async () => {
    const ingest = [];
    const fetched = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      loadMaloumCreator: async () => ({
        creator: { id: 'cr-1', providerUserId: 'me' },
      }),
      listChats: async () => [],
      getMessages: async (_creator, chatId) => {
        fetched.push(chatId);
        return [
          {
            _id: 'm2',
            senderId: 'fan',
            content: { type: 'text', text: 'follow up' },
            sentAt: '2026-09-09T00:02:00.000Z',
          },
        ];
      },
      listRecentConversations: async () => [
        { platformChatId: 'chat-2', platformFanId: 'fan-2' },
      ],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
    });
    assert.deepEqual(fetched, ['chat-2']);
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].source, 'recent_active');
    assert.equal(ingest[0].platformChatId, 'chat-2');
    assert.equal(ingest[0].messages[0].direction, 'inbound');
  });

  it('keeps polling other chats when one chat 404s', async () => {
    const ingest = [];
    const now = 5_000;
    const result = await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      loadMaloumCreator: async () => ({
        creator: { id: 'cr-1', providerUserId: 'me' },
      }),
      listChats: async () => [
        {
          _id: 'dead',
          unreadMessages: true,
          chatPartner: { _id: 'fan-dead' },
        },
        {
          _id: 'alive',
          unreadMessages: true,
          chatPartner: { _id: 'fan-alive' },
        },
      ],
      getMessages: async (_creator, chatId) => {
        if (chatId === 'dead') {
          const err = new Error('Chat cannot be found');
          err.status = 404;
          throw err;
        }
        return [
          {
            _id: 'm1',
            senderId: 'fan-alive',
            content: { type: 'text', text: 'hi' },
            sentAt: '2026-09-09T00:00:00.000Z',
          },
        ];
      },
      resolvePlatformChat: async () => ({ platformChatId: null, source: null }),
      listRecentConversations: async () => [],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      now: () => now,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.polled, 1);
    assert.equal(isBackedOff('cr-1', now + 1), false);
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].platformChatId, 'alive');
  });

  it('resolves a recent_active 404 via createChat then ingests the real id', async () => {
    const ingest = [];
    const fetched = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      loadMaloumCreator: async () => ({
        creator: { id: 'cr-1', providerUserId: 'me' },
      }),
      listChats: async () => [],
      getMessages: async (_creator, chatId) => {
        fetched.push(chatId);
        if (chatId === 'stale') {
          const err = new Error('Chat cannot be found');
          err.status = 404;
          throw err;
        }
        return [
          {
            _id: 'm2',
            senderId: 'fan-2',
            content: { type: 'text', text: 'follow up' },
            sentAt: '2026-09-09T00:02:00.000Z',
          },
        ];
      },
      resolvePlatformChat: async () => ({
        platformChatId: 'fresh',
        source: 'createChat',
      }),
      listRecentConversations: async () => [
        { platformChatId: 'stale', platformFanId: 'fan-2' },
      ],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
    });
    assert.deepEqual(fetched, ['stale', 'fresh']);
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].platformChatId, 'fresh');
    assert.equal(ingest[0].source, 'recent_active');
  });
});
