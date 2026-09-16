const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  selectEligibleCreators,
  mapFourBasedMessagesForIngest,
  isUnreadFourBasedChat,
  nextBackoffMs,
  isBackedOff,
  recordSuccess,
  recordFailure,
  resetPollerBackoff,
  stopFourBasedInboundPoller,
  tick,
  PAGE_LIMIT,
  BACKOFF_STEPS_MS,
  BACKOFF_CAP_MS,
} = require('./fourBasedInboundPoller');

const ON_FLAGS = {
  enabled: true,
  shadowAllowed: true,
  suggestAllowed: true,
  autoSendAllowed: false,
};

const ELIGIBLE_ROW = {
  id: 'cr-1',
  platform: '4based',
  connectionStatus: 'connected',
  mode: MODES.SHADOW,
  paused: false,
};

describe('selectEligibleCreators', () => {
  beforeEach(() => {
    resetPollerBackoff();
    stopFourBasedInboundPoller();
  });

  it('keeps eligible connected 4based creators', () => {
    const rows = [
      ELIGIBLE_ROW,
      {
        id: 'off-1',
        platform: '4based',
        connectionStatus: 'connected',
        mode: MODES.OFF,
        paused: false,
      },
      {
        id: 'disc-1',
        platform: '4based',
        connectionStatus: 'disconnected',
        mode: MODES.SHADOW,
        paused: false,
      },
      {
        id: 'paused-1',
        platform: '4based',
        connectionStatus: 'connected',
        mode: MODES.SUGGEST_ONLY,
        paused: true,
      },
      {
        id: 'maloum-1',
        platform: 'maloum',
        connectionStatus: 'connected',
        mode: MODES.SHADOW,
        paused: false,
      },
      {
        id: 'suggest-1',
        platform: '4based',
        connectionStatus: 'connected',
        mode: MODES.SUGGEST_ONLY,
        paused: false,
      },
    ];
    assert.deepEqual(
      selectEligibleCreators(rows, ON_FLAGS).map((row) => row.id),
      ['cr-1', 'suggest-1']
    );
  });

  it('returns none when global AI is off', () => {
    assert.deepEqual(
      selectEligibleCreators([ELIGIBLE_ROW], { ...ON_FLAGS, enabled: false }),
      []
    );
  });
});

describe('mapFourBasedMessagesForIngest', () => {
  it('skips deleted messages and marks creator outbound', () => {
    const mapped = mapFourBasedMessagesForIngest(
      [
        {
          _id: 'gone',
          user_id: 'fan',
          message: 'x',
          deleted_user_ids: ['fan'],
        },
        {
          _id: 'm1',
          user_id: 'me',
          message: 'hi',
          created_at: '2026-09-09T00:00:00.000Z',
        },
        {
          _id: 'm2',
          user_id: 'fan',
          message: 'hey',
          file_stack: { price: 121 },
          created_at: '2026-09-09T00:01:00.000Z',
        },
      ],
      'me'
    );
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].direction, 'outbound');
    assert.equal(mapped[1].direction, 'inbound');
    assert.equal(mapped[1].isPpv, true);
    assert.equal(mapped[1].priceNet, 1);
  });
});

describe('isUnreadFourBasedChat', () => {
  it('keeps chats with unread count or missing count plus last fan message', () => {
    assert.equal(
      isUnreadFourBasedChat({ _id: 'c1', unread_message_count: 2 }, 'me'),
      true
    );
    assert.equal(
      isUnreadFourBasedChat({ _id: 'c2', unread_message_count: 0 }, 'me'),
      false
    );
    assert.equal(
      isUnreadFourBasedChat(
        { _id: 'c3', last_message: { user_id: 'fan' } },
        'me'
      ),
      true
    );
    assert.equal(
      isUnreadFourBasedChat(
        { _id: 'c4', last_message: { user_id: 'me' } },
        'me'
      ),
      false
    );
  });
});

describe('backoff helpers', () => {
  beforeEach(() => {
    resetPollerBackoff();
  });

  it('steps 30s/60s/120s and caps at 5 minutes', () => {
    assert.equal(nextBackoffMs(1), BACKOFF_STEPS_MS[0]);
    assert.equal(nextBackoffMs(2), BACKOFF_STEPS_MS[1]);
    assert.equal(nextBackoffMs(3), BACKOFF_STEPS_MS[2]);
    assert.equal(nextBackoffMs(99), BACKOFF_STEPS_MS[2]);
    assert.ok(nextBackoffMs(99) <= BACKOFF_CAP_MS);
  });

  it('records failure then success', () => {
    const now = 1_000;
    recordFailure('cr-1', now);
    assert.equal(isBackedOff('cr-1', now + 1), true);
    recordSuccess('cr-1');
    assert.equal(isBackedOff('cr-1', now + 1), false);
  });
});

describe('tick', () => {
  beforeEach(() => {
    resetPollerBackoff();
    stopFourBasedInboundPoller();
  });

  it('calls unread list and ingests mapped messages', async () => {
    const ingest = [];
    const listed = [];
    const result = await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      loadFourBasedCreator: async () => ({
        creator: { id: 'cr-1', providerUserId: 'me' },
      }),
      listChats: async (_creator, opts) => {
        listed.push(opts);
        return [
          {
            _id: 'chat-1',
            unread_message_count: 2,
            user_ids: ['me', 'fan-1'],
          },
        ];
      },
      getMessages: async () => [
        {
          _id: 'm1',
          user_id: 'fan-1',
          message: 'hi',
          created_at: '2026-09-09T00:00:00.000Z',
        },
      ],
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.polled, 1);
    assert.deepEqual(listed[0], { limit: PAGE_LIMIT, listName: 'unread' });
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].platform, '4based');
    assert.equal(ingest[0].source, 'poll');
    assert.equal(ingest[0].platformFanId, 'fan-1');
    assert.equal(ingest[0].messages[0].direction, 'inbound');
  });

  it('does not ingest when unread list is empty', async () => {
    let getMessagesCalls = 0;
    const ingest = [];
    await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [ELIGIBLE_ROW],
      loadFourBasedCreator: async () => ({
        creator: { id: 'cr-1', providerUserId: 'me' },
      }),
      listChats: async () => [{ _id: 'chat-1', unread_message_count: 0 }],
      getMessages: async () => {
        getMessagesCalls += 1;
        return [];
      },
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
    });
    assert.equal(getMessagesCalls, 0);
    assert.equal(ingest.length, 0);
  });

  it('skips when creator mode is off', async () => {
    let listCalls = 0;
    const result = await tick({
      getAiFlags: async () => ON_FLAGS,
      loadEligibleRows: async () => [{ ...ELIGIBLE_ROW, mode: MODES.OFF }],
      listChats: async () => {
        listCalls += 1;
        return [];
      },
      ingestConversation: async () => {},
    });
    assert.equal(result.eligible, 0);
    assert.equal(listCalls, 0);
  });

  it('skips when global AI is off', async () => {
    let loadRows = 0;
    const result = await tick({
      getAiFlags: async () => ({ ...ON_FLAGS, enabled: false }),
      loadEligibleRows: async () => {
        loadRows += 1;
        return [ELIGIBLE_ROW];
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'ai_off');
    assert.equal(loadRows, 0);
  });
});
