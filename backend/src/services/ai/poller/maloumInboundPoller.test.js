const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  selectEligibleCreators,
  mapMaloumMessagesForIngest,
  resetPollerBackoff,
} = require('./maloumInboundPoller');

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
