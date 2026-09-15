const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const { ingestLiveTelegramMessage } = require('./telegramLiveIngest');
const {
  selectEligibleCreators,
  mapTelegramMessagesForIngest,
  PAGE_LIMIT,
} = require('./telegramInboundPoller');

const ELIGIBLE = {
  id: 'cr-1',
  platform: 'telegram',
  connectionStatus: 'connected',
  mode: MODES.SUGGEST_ONLY,
  paused: false,
};

describe('ingestLiveTelegramMessage', () => {
  it('skips outgoing messages', async () => {
    const listed = [];
    const result = await ingestLiveTelegramMessage(
      'cr-1',
      { isOutgoing: true, chat: { id: '111' } },
      {
        telegramWorker: {
          isTelegramServiceDialog: () => false,
          listMessages: async () => {
            listed.push(true);
            return { messages: [] };
          },
        },
      }
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'outgoing');
    assert.equal(listed.length, 0);
  });

  it('lists with markRead false and ingests for an eligible creator', async () => {
    const ingest = [];
    const listed = [];
    const result = await ingestLiveTelegramMessage(
      'cr-1',
      { isOutgoing: false, chat: { id: '111' }, id: 'm9' },
      {
        getAiFlags: async () => ({
          enabled: true,
          shadowAllowed: true,
          suggestAllowed: true,
          autoSendAllowed: false,
        }),
        loadCreatorRow: async () => ELIGIBLE,
        selectEligibleCreators,
        mapTelegramMessagesForIngest,
        PAGE_LIMIT,
        telegramWorker: {
          isTelegramServiceDialog: () => false,
        },
        listMessages: async (creatorId, peerId, opts) => {
          listed.push({ creatorId, peerId, opts });
          return {
            messages: [
              {
                id: 'm9',
                isOutgoing: false,
                text: 'hey',
                date: '2026-09-09T12:00:00.000Z',
              },
            ],
          };
        },
        ingestConversation: async (payload) => {
          ingest.push(payload);
        },
      }
    );
    assert.equal(result.skipped, false);
    assert.equal(result.peerId, '111');
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].opts, { limit: PAGE_LIMIT, markRead: false });
    assert.equal(ingest.length, 1);
    assert.equal(ingest[0].source, 'live');
    assert.equal(ingest[0].skipProcess, false);
    assert.equal(ingest[0].platformChatId, '111');
    assert.equal(ingest[0].messages[0].platformMessageId, 'm9');
  });

  it('skips ineligible creators without listing messages', async () => {
    const listed = [];
    const result = await ingestLiveTelegramMessage(
      'cr-1',
      { isOutgoing: false, chat: { id: '111' } },
      {
        getAiFlags: async () => ({ enabled: true }),
        loadCreatorRow: async () => ({ ...ELIGIBLE, paused: true }),
        selectEligibleCreators,
        mapTelegramMessagesForIngest,
        telegramWorker: { isTelegramServiceDialog: () => false },
        listMessages: async () => {
          listed.push(true);
          return { messages: [] };
        },
      }
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'ineligible');
    assert.equal(listed.length, 0);
  });
});
