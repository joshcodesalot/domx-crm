const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  BOT_API_ORIGIN,
  readConfig,
  isConfigured,
  isAllowedChat,
  parseCommand,
  botMethodUrl,
  notifyAlertChats,
  dispatchCommand,
  handleUpdate,
  startTelegramAlertBot,
  stopTelegramAlertBot,
} = require('./telegramAlertBot');

const CONFIG = {
  token: 'test-token',
  chatIds: ['111'],
};

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() {
      return body;
    },
  };
}

describe('telegramAlertBot isolation', () => {
  it('does not require telegramWorker or send fan messages', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'telegramAlertBot.js'),
      'utf8'
    );
    assert.equal(/require\([^)]*telegramWorker/.test(src), false);
    assert.equal(src.includes('sendVaultToPeer'), false);
    assert.equal(src.includes('encryptedSession'), false);
    assert.equal(src.includes('TELEGRAM_API_ID'), false);
    assert.equal(src.includes('peerId'), false);
  });
});

describe('readConfig', () => {
  it('is unconfigured without token or chat ids', () => {
    assert.equal(isConfigured(readConfig({})), false);
    assert.equal(
      isConfigured(readConfig({ TELEGRAM_ALERT_BOT_TOKEN: 'tok' })),
      false
    );
    assert.equal(
      isConfigured(readConfig({ TELEGRAM_ALERT_CHAT_IDS: '111' })),
      false
    );
  });

  it('parses comma-separated chat ids', () => {
    const config = readConfig({
      TELEGRAM_ALERT_BOT_TOKEN: 'tok',
      TELEGRAM_ALERT_CHAT_IDS: '111, 222',
    });
    assert.equal(isConfigured(config), true);
    assert.deepEqual(config.chatIds, ['111', '222']);
  });
});

describe('parseCommand', () => {
  it('reads slash commands and args', () => {
    assert.deepEqual(parseCommand('/pause cr-1'), { name: 'pause', arg: 'cr-1' });
    assert.deepEqual(parseCommand('/cost'), { name: 'cost', arg: '' });
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand('/send fan-1 hi'), null);
  });
});

describe('isAllowedChat', () => {
  it('only allows listed chat ids', () => {
    assert.equal(isAllowedChat(111, CONFIG), true);
    assert.equal(isAllowedChat('111', CONFIG), true);
    assert.equal(isAllowedChat(999, CONFIG), false);
  });
});

describe('botMethodUrl', () => {
  it('uses the public Bot API origin', () => {
    assert.equal(
      botMethodUrl('tok', 'sendMessage'),
      `${BOT_API_ORIGIN}/bottok/sendMessage`
    );
  });
});

describe('dispatchCommand', () => {
  it('pauses and resumes a creator', async () => {
    const paused = [];
    const reply = await dispatchCommand(
      { name: 'pause', arg: 'cr-1' },
      {
        setCreatorPaused: async (id, value) => {
          paused.push({ id, value });
          return { creatorId: id, paused: value };
        },
      }
    );
    assert.equal(reply, 'Paused cr-1');
    assert.deepEqual(paused, [{ id: 'cr-1', value: true }]);

    const resumed = await dispatchCommand(
      { name: 'resume', arg: 'cr-1' },
      {
        setCreatorPaused: async (id, value) => {
          paused.push({ id, value });
          return { creatorId: id, paused: value };
        },
      }
    );
    assert.equal(resumed, 'Resumed cr-1');
    assert.equal(paused[1].value, false);
  });

  it('takeovers and releases a conversation', async () => {
    const calls = [];
    const takeover = await dispatchCommand(
      { name: 'takeover', arg: 'conv-1' },
      {
        takeoverConversation: async (input) => {
          calls.push(['takeover', input]);
          return { id: input.conversationId };
        },
      }
    );
    assert.equal(takeover, 'Takeover conv-1');
    assert.equal(calls[0][1].userId, null);

    const released = await dispatchCommand(
      { name: 'release', arg: 'conv-1' },
      {
        resumeConversation: async (input) => {
          calls.push(['release', input]);
          return { id: input.conversationId };
        },
      }
    );
    assert.equal(released, 'Released conv-1');
  });

  it('returns today cost totals', async () => {
    const reply = await dispatchCommand(
      { name: 'cost', arg: '' },
      {
        summarizeUsage: async () => ({
          totals: { runs: 3, costUsd: 1.25 },
        }),
      }
    );
    assert.equal(reply, 'Today: 3 runs, $1.2500');
  });
});

describe('handleUpdate', () => {
  it('ignores chats that are not allowlisted', async () => {
    const fetchCalls = [];
    const result = await handleUpdate(
      { message: { chat: { id: 999 }, text: '/pause cr-1' } },
      {
        config: CONFIG,
        fetch: async (...args) => {
          fetchCalls.push(args);
          return jsonResponse({ ok: true });
        },
      }
    );
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'not_allowed');
    assert.equal(fetchCalls.length, 0);
  });

  it('replies to an allowlisted pause command via Bot API', async () => {
    const fetchCalls = [];
    const paused = [];
    const result = await handleUpdate(
      { message: { chat: { id: 111 }, text: '/pause cr-1' } },
      {
        config: CONFIG,
        setCreatorPaused: async (id, value) => {
          paused.push({ id, value });
          return { creatorId: id, paused: value };
        },
        fetch: async (url, init) => {
          fetchCalls.push({ url, init });
          return jsonResponse({ ok: true });
        },
      }
    );
    assert.equal(result.handled, true);
    assert.equal(paused[0].value, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, `${BOT_API_ORIGIN}/bottest-token/sendMessage`);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.chat_id, 111);
    assert.equal(body.text, 'Paused cr-1');
  });
});

describe('notifyAlertChats', () => {
  it('posts to every allowlisted chat', async () => {
    const fetchCalls = [];
    const result = await notifyAlertChats('boom', {
      config: { token: 'tok', chatIds: ['111', '222'] },
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return jsonResponse({ ok: true });
      },
    });
    assert.equal(result.sent, 2);
    assert.equal(fetchCalls[0].url.startsWith(BOT_API_ORIGIN), true);
    assert.equal(JSON.parse(fetchCalls[0].init.body).text, 'boom');
  });

  it('is a no-op when unconfigured', async () => {
    const result = await notifyAlertChats('boom', {
      config: { token: '', chatIds: [] },
      fetch: async () => {
        throw new Error('should not fetch');
      },
    });
    assert.equal(result.sent, 0);
  });
});

describe('startTelegramAlertBot', () => {
  it('does not start without env', () => {
    stopTelegramAlertBot();
    const result = startTelegramAlertBot({
      config: { token: '', chatIds: [] },
    });
    assert.equal(result.started, false);
  });
});
