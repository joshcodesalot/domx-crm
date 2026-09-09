const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  selectEligibleCreators,
  mapTelegramMessagesForIngest,
  resetPollerBackoff,
  stopTelegramInboundPoller,
  tick,
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
      listMessages: async (_id, peerId) => ({
        messages: [
          {
            id: 'm1',
            isOutgoing: false,
            text: 'hi',
            date: '2026-09-09T00:00:00.000Z',
          },
        ],
      }),
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(result.polled, 1);
    assert.deepEqual(listed[0], { limit: DIALOG_LIMIT });
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
      ingestConversation: async (payload) => {
        ingest.push(payload);
      },
      isTelegramServiceDialog,
    });
    assert.equal(messageCalls, 0);
    assert.equal(ingest.length, 0);
  });
});
