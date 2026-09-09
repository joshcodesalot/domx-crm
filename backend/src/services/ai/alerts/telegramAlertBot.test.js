const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  BOT_API_ORIGIN,
  HELP_TEXT,
  parseChatEntry,
  parseTopicId,
  readConfig,
  isConfigured,
  isAllowedChat,
  topicForChat,
  buildSendPayload,
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
    assert.equal(config.defaultTopicId, null);
  });

  it('parses chat:topic entries and a global topic id', () => {
    const config = readConfig({
      TELEGRAM_ALERT_BOT_TOKEN: 'tok',
      TELEGRAM_ALERT_CHAT_IDS: '-100123:12,123456789',
      TELEGRAM_ALERT_TOPIC_ID: '9',
    });
    assert.deepEqual(config.chatIds, ['-100123', '123456789']);
    assert.equal(config.topicsByChat['-100123'], 12);
    assert.equal(config.defaultTopicId, 9);
    assert.equal(topicForChat('-100123', config), 12);
    assert.equal(topicForChat('123456789', config), 9);
  });
});

describe('parseChatEntry', () => {
  it('keeps plain ids and optional topics', () => {
    assert.deepEqual(parseChatEntry('123456789'), { chatId: '123456789', topicId: null });
    assert.deepEqual(parseChatEntry('-100123:12'), { chatId: '-100123', topicId: 12 });
    assert.equal(parseTopicId(''), null);
    assert.equal(parseTopicId('0'), null);
  });
});

describe('parseCommand', () => {
  it('reads slash commands and args', () => {
    assert.deepEqual(parseCommand('/pause cr-1'), { name: 'pause', arg: 'cr-1' });
    assert.deepEqual(parseCommand('/cost'), { name: 'cost', arg: '' });
    assert.deepEqual(parseCommand('/help'), { name: 'help', arg: '' });
    assert.deepEqual(parseCommand('/commands'), { name: 'commands', arg: '' });
    assert.deepEqual(parseCommand('/help@BotName'), { name: 'help', arg: '' });
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

  it('authorizes by chat id, not topic', () => {
    const config = readConfig({
      TELEGRAM_ALERT_BOT_TOKEN: 'tok',
      TELEGRAM_ALERT_CHAT_IDS: '-100123:12',
    });
    assert.equal(isAllowedChat(-100123, config), true);
    assert.equal(isAllowedChat('-100123', config), true);
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

  it('returns the same usage list for help and commands', async () => {
    const help = await dispatchCommand({ name: 'help', arg: '' });
    const commands = await dispatchCommand({ name: 'commands', arg: '' });
    assert.equal(help, HELP_TEXT);
    assert.equal(commands, HELP_TEXT);
    assert.equal(help, commands);
    for (const name of [
      '/help',
      '/commands',
      '/cost',
      '/pause',
      '/resume',
      '/takeover',
      '/release',
    ]) {
      assert.equal(help.includes(name), true, `missing ${name}`);
    }
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

  it('replies to /help from an allowed chat', async () => {
    const fetchCalls = [];
    const result = await handleUpdate(
      { message: { chat: { id: 111 }, text: '/help' } },
      {
        config: CONFIG,
        fetch: async (url, init) => {
          fetchCalls.push({ url, init });
          return jsonResponse({ ok: true });
        },
      }
    );
    assert.equal(result.handled, true);
    assert.equal(result.command, 'help');
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.chat_id, 111);
    assert.equal(body.text, HELP_TEXT);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'message_thread_id'), false);
  });

  it('does not reply to /help from a disallowed chat', async () => {
    const fetchCalls = [];
    const result = await handleUpdate(
      { message: { chat: { id: 999 }, text: '/help' } },
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
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'message_thread_id'), false);
  });

  it('echoes forum message_thread_id on command replies', async () => {
    const fetchCalls = [];
    const result = await handleUpdate(
      {
        message: {
          chat: { id: 111 },
          message_thread_id: 12,
          text: '/cost',
        },
      },
      {
        config: CONFIG,
        summarizeUsage: async () => ({ totals: { runs: 1, costUsd: 0 } }),
        fetch: async (url, init) => {
          fetchCalls.push({ url, init });
          return jsonResponse({ ok: true });
        },
      }
    );
    assert.equal(result.handled, true);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.chat_id, 111);
    assert.equal(body.message_thread_id, 12);
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
    const first = JSON.parse(fetchCalls[0].init.body);
    assert.equal(first.text, 'boom');
    assert.equal(Object.prototype.hasOwnProperty.call(first, 'message_thread_id'), false);
  });

  it('includes message_thread_id when a global topic is configured', async () => {
    const fetchCalls = [];
    await notifyAlertChats('boom', {
      config: {
        token: 'tok',
        chatIds: ['111'],
        defaultTopicId: 12,
      },
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return jsonResponse({ ok: true });
      },
    });
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(body, { chat_id: '111', text: 'boom', message_thread_id: 12 });
  });

  it('uses per-chat topic over the global default', async () => {
    const fetchCalls = [];
    await notifyAlertChats('boom', {
      config: {
        token: 'tok',
        chatIds: ['-100123', '111'],
        topicsByChat: { '-100123': 12 },
        defaultTopicId: 9,
      },
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return jsonResponse({ ok: true });
      },
    });
    const forum = JSON.parse(fetchCalls[0].init.body);
    const dm = JSON.parse(fetchCalls[1].init.body);
    assert.equal(forum.chat_id, '-100123');
    assert.equal(forum.message_thread_id, 12);
    assert.equal(dm.chat_id, '111');
    assert.equal(dm.message_thread_id, 9);
  });

  it('omits message_thread_id from buildSendPayload when no topic is set', () => {
    assert.deepEqual(buildSendPayload('123', 'hi', null), {
      chat_id: '123',
      text: 'hi',
    });
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
