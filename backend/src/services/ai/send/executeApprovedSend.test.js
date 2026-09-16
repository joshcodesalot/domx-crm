const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ReviewError,
  isSuggestionStale,
  asMessageId,
  executeApprovedSend,
} = require('./executeApprovedSend');
const { processIncomingMessage, shouldSkipGenerate } = require('../orchestrator');
const { MODES } = require('../contracts');
const { requirePermission } = require('../../../middleware/authorize');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createSendHarness(overrides = {}) {
  const suggestion = {
    id: 'sug-1',
    status: 'pending',
    platform: 'maloum',
    revision: 2,
    anchorInboundMessageId: 'in-1',
    conversationId: 'conv-1',
    creatorId: 'cr-1',
    platformChatId: 'chat-1',
    reply: 'hallo',
    replyEnglish: 'hello',
    ...(overrides.suggestion || {}),
  };
  const conversation = {
    id: 'conv-1',
    lastInboundPlatformMessageId: 'in-1',
    revision: 2,
    platformFanId: 'fan-1',
    ...(overrides.conversation || {}),
  };

  let current = { ...suggestion };
  const sendText = async (...args) => {
    sendText.calls.push(args);
    if (typeof overrides.sendText === 'function') {
      return overrides.sendText(...args);
    }
    return { _id: 'msg-99' };
  };
  sendText.calls = [];

  const sendFourBasedMessage = async (...args) => {
    sendFourBasedMessage.calls.push(args);
    if (typeof overrides.sendFourBasedMessage === 'function') {
      return overrides.sendFourBasedMessage(...args);
    }
    return { _id: 'fb-99' };
  };
  sendFourBasedMessage.calls = [];

  const sendTelegramText = async (...args) => {
    sendTelegramText.calls.push(args);
    if (typeof overrides.sendTelegramText === 'function') {
      return overrides.sendTelegramText(...args);
    }
    return { id: 'tg-99' };
  };
  sendTelegramText.calls = [];

  const sendMedia = async (...args) => {
    sendMedia.calls.push(args);
    if (typeof overrides.sendMedia === 'function') {
      return overrides.sendMedia(...args);
    }
    return { _id: 'msg-ppv' };
  };
  sendMedia.calls = [];

  const markMaloumRead = async (...args) => {
    markMaloumRead.calls.push(args);
    if (typeof overrides.markMaloumRead === 'function') {
      return overrides.markMaloumRead(...args);
    }
  };
  markMaloumRead.calls = [];

  const markFourBasedReceived = async (...args) => {
    markFourBasedReceived.calls.push(args);
    if (typeof overrides.markFourBasedReceived === 'function') {
      return overrides.markFourBasedReceived(...args);
    }
  };
  markFourBasedReceived.calls = [];

  const dashboardInserts = [];
  const vaultSent = [];
  const scriptSends = [];
  const ruleSuggestions = [];
  const deps = {
    pool: {},
    getSuggestionById: async () => current,
    loadConversation: async () => conversation,
    updateSuggestionStatus: async (_id, patch) => {
      Object.assign(current, patch);
      return { ...current };
    },
    applyModeration: overrides.applyModeration || (async () => ({ blocked: false })),
    loadMaloumCreator: async () => ({
      creator: { id: 'cr-1', displayName: 'Naomi', accessToken: 't', proxyUrl: 'http://p' },
    }),
    loadFourBasedCreator: async () => ({
      creator: { id: 'cr-1', displayName: 'Naomi', providerUserId: 'me' },
    }),
    sendText,
    sendFourBasedMessage,
    sendTelegramText,
    sendMedia,
    loadMediaCandidates:
      overrides.loadMediaCandidates ||
      (async () => overrides.mediaCandidates || []),
    hasVaultSent: overrides.hasVaultSent || (async () => false),
    hasPurchasedMedia: overrides.hasPurchasedMedia || (async () => false),
    recordVaultSent: async (row) => {
      vaultSent.push(row);
    },
    recordScriptSend: async (row) => {
      scriptSends.push(row);
    },
    insertDashboard: async (entry) => {
      dashboardInserts.push(entry);
    },
    maybeSuggestRuleFromEdit:
      overrides.maybeSuggestRuleFromEdit ||
      (async (row) => {
        ruleSuggestions.push(row);
        return { status: 'pending' };
      }),
    emitSuggestionEvent: async () => ({ emitted: true }),
    markMaloumRead,
    markFourBasedReceived,
    withConversationLock: async (_db, _key, fn) => fn({}),
    loadCreatorRow: async () => ({
      displayName: 'Naomi',
      username: 'naomi',
      avatarUrl: null,
    }),
    getAiFlags: async () => ({
      enabled: true,
      shadowAllowed: true,
      suggestAllowed: true,
      autoSendAllowed: false,
      ...(overrides.global || {}),
    }),
    loadCreatorSettings: async () =>
      overrides.settings === undefined
        ? { mode: MODES.SUGGEST_ONLY, paused: false }
        : overrides.settings,
  };

  return {
    deps,
    conversation,
    sendText,
    sendFourBasedMessage,
    sendTelegramText,
    sendMedia,
    markMaloumRead,
    markFourBasedReceived,
    dashboardInserts,
    vaultSent,
    scriptSends,
    ruleSuggestions,
    getCurrent: () => current,
    user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
  };
}

describe('isSuggestionStale', () => {
  it('is stale when inbound anchor moved', () => {
    assert.equal(
      isSuggestionStale(
        { anchorInboundMessageId: 'in-1', revision: 2 },
        { lastInboundPlatformMessageId: 'in-2', revision: 2 }
      ),
      true
    );
  });

  it('is stale when conversation revision is higher', () => {
    assert.equal(
      isSuggestionStale(
        { anchorInboundMessageId: 'in-1', revision: 2 },
        { lastInboundPlatformMessageId: 'in-1', revision: 3 }
      ),
      true
    );
  });

  it('is fresh when anchor and revision match', () => {
    assert.equal(
      isSuggestionStale(
        { anchorInboundMessageId: 'in-1', revision: 2 },
        { lastInboundPlatformMessageId: 'in-1', revision: 2 }
      ),
      false
    );
  });
});

describe('asMessageId', () => {
  it('reads string or _id', () => {
    assert.equal(asMessageId('abc'), 'abc');
    assert.equal(asMessageId({ _id: 'm1' }), 'm1');
    assert.equal(asMessageId({}), null);
  });
});

describe('executeApprovedSend', () => {
  it('returns 409 and does not send when inbound is newer', async () => {
    const harness = createSendHarness({
      conversation: { lastInboundPlatformMessageId: 'in-2', revision: 2 },
    });

    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) =>
        err instanceof ReviewError &&
        err.status === 409 &&
        err.code === 'stale'
    );
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.markMaloumRead.calls.length, 0);
    assert.equal(harness.getCurrent().status, 'stale');
    assert.equal(harness.dashboardInserts.length, 0);
  });

  it('returns 409 and does not send when revision is higher', async () => {
    const harness = createSendHarness({
      conversation: { lastInboundPlatformMessageId: 'in-1', revision: 5 },
    });

    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 409 && err.code === 'stale'
    );
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.getCurrent().status, 'stale');
  });

  it('sends via mock sendText and inserts the dashboard row', async () => {
    const harness = createSendHarness();
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', user: harness.user },
      harness.deps
    );

    assert.equal(result.messageId, 'msg-99');
    assert.equal(result.suggestion.status, 'sent');
    assert.equal(result.suggestion.sentPlatformMessageId, 'msg-99');
    assert.equal(harness.sendText.calls.length, 1);
    assert.equal(harness.sendText.calls[0][1], 'chat-1');
    assert.equal(harness.sendText.calls[0][2].text, 'hallo');
    assert.equal(harness.markMaloumRead.calls.length, 1);
    assert.equal(harness.markMaloumRead.calls[0][1], 'chat-1');
    assert.equal(harness.dashboardInserts.length, 1);
    assert.equal(harness.dashboardInserts[0].maloumMessageId, 'msg-99');
    assert.equal(harness.dashboardInserts[0].actualSentText, 'hallo');
    assert.equal(harness.dashboardInserts[0].chatterId, 'user-1');
  });

  it('sends via sendText with no user and inserts dashboard as AI', async () => {
    const harness = createSendHarness();
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', user: null, edited: false },
      harness.deps
    );

    assert.equal(result.messageId, 'msg-99');
    assert.equal(result.suggestion.status, 'sent');
    assert.equal(harness.sendText.calls.length, 1);
    assert.equal(harness.sendText.calls[0][2].text, 'hallo');
    assert.equal(harness.sendMedia.calls.length, 0);
    assert.equal(harness.dashboardInserts.length, 1);
    assert.equal(harness.dashboardInserts[0].chatterId, null);
    assert.equal(harness.dashboardInserts[0].chatterName, 'AI');
    assert.equal(harness.dashboardInserts[0].actualSentText, 'hallo');
  });

  it('rejects unknown platforms before calling sendText', async () => {
    const harness = createSendHarness({
      suggestion: { platform: 'onlyfans' },
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 400 && err.code === 'platform_not_supported'
    );
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.sendFourBasedMessage.calls.length, 0);
    assert.equal(harness.sendTelegramText.calls.length, 0);
  });

  it('sends 4based TEXT_REPLY via sendFourBasedMessage', async () => {
    const harness = createSendHarness({
      suggestion: { platform: '4based' },
    });
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', user: harness.user },
      harness.deps
    );
    assert.equal(result.messageId, 'fb-99');
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.sendFourBasedMessage.calls.length, 1);
    assert.equal(harness.sendFourBasedMessage.calls[0][1], 'chat-1');
    assert.equal(harness.sendFourBasedMessage.calls[0][2].message, 'hallo');
    assert.equal(harness.markFourBasedReceived.calls.length, 1);
    assert.equal(harness.markMaloumRead.calls.length, 0);
    assert.equal(harness.dashboardInserts[0].platform, '4based');
    assert.equal(harness.dashboardInserts[0].maloumMessageId, '4based:fb-99');
  });

  it('sends telegram TEXT_REPLY via sendTelegramText', async () => {
    const harness = createSendHarness({
      suggestion: { platform: 'telegram' },
    });
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', user: harness.user },
      harness.deps
    );
    assert.equal(result.messageId, 'tg-99');
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.sendTelegramText.calls.length, 1);
    assert.equal(harness.sendTelegramText.calls[0][0], 'cr-1');
    assert.equal(harness.sendTelegramText.calls[0][1], 'chat-1');
    assert.equal(harness.sendTelegramText.calls[0][2], 'hallo');
    assert.equal(harness.dashboardInserts[0].platform, 'telegram');
    assert.equal(harness.dashboardInserts[0].maloumMessageId, 'telegram:tg-99');
  });

  it('rejects shadow mode before calling sendText', async () => {
    const harness = createSendHarness({
      settings: { mode: MODES.SHADOW, paused: false },
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) =>
        err instanceof ReviewError &&
        err.status === 403 &&
        err.code === 'SHADOW_MODE'
    );
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.getCurrent().status, 'pending');
  });

  const ppvSuggestion = {
    action: 'SEND_PPV',
    output: {
      action: 'SEND_PPV',
      mediaId: 'up-1',
      price: 12,
      scriptId: 'sc-1',
    },
  };
  const ppvCandidate = {
    source: 'script',
    mediaId: 'up-1',
    type: 'video',
    note: null,
    price: 12,
    scriptId: 'sc-1',
    title: 'Clip',
  };

  it('sends PPV via sendMedia and not sendText', async () => {
    const harness = createSendHarness({
      suggestion: ppvSuggestion,
      mediaCandidates: [ppvCandidate],
    });
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', user: harness.user },
      harness.deps
    );

    assert.equal(result.messageId, 'msg-ppv');
    assert.equal(harness.sendText.calls.length, 0);
    assert.equal(harness.sendMedia.calls.length, 1);
    assert.equal(harness.sendMedia.calls[0][1], 'chat-1');
    assert.deepEqual(harness.sendMedia.calls[0][2].media, [
      { mediaId: 'up-1', type: 'video' },
    ]);
    assert.equal(harness.sendMedia.calls[0][2].priceNet, 12);
    assert.equal(harness.sendMedia.calls[0][2].text, 'hallo');
    assert.equal(harness.dashboardInserts[0].contentType, 'chat_product');
    assert.equal(harness.dashboardInserts[0].priceNet, 12);
    assert.equal(harness.dashboardInserts[0].purchased, false);
    assert.equal(harness.vaultSent.length, 1);
    assert.equal(harness.scriptSends[0].scriptId, 'sc-1');
  });

  it('does not send when the media was already sent', async () => {
    const harness = createSendHarness({
      suggestion: ppvSuggestion,
      mediaCandidates: [ppvCandidate],
      hasVaultSent: async () => true,
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 409 && err.code === 'ppv_sent'
    );
    assert.equal(harness.sendMedia.calls.length, 0);
    assert.equal(harness.sendText.calls.length, 0);
  });

  it('does not send when the fan already purchased that media', async () => {
    const harness = createSendHarness({
      suggestion: ppvSuggestion,
      mediaCandidates: [ppvCandidate],
      hasPurchasedMedia: async () => true,
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 409 && err.code === 'ppv_purchased'
    );
    assert.equal(harness.sendMedia.calls.length, 0);
    assert.equal(harness.sendText.calls.length, 0);
  });

  it('does not send when the candidate has no price', async () => {
    const harness = createSendHarness({
      suggestion: ppvSuggestion,
      mediaCandidates: [{ ...ppvCandidate, price: null }],
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 403 && err.code === 'ppv_price'
    );
    assert.equal(harness.sendMedia.calls.length, 0);
    assert.equal(harness.sendText.calls.length, 0);
  });

  it('rejects SEND_PPV on 4based and telegram', async () => {
    for (const platform of ['4based', 'telegram']) {
      const harness = createSendHarness({
        suggestion: { platform, ...ppvSuggestion },
        mediaCandidates: [ppvCandidate],
      });
      await assert.rejects(
        () =>
          executeApprovedSend(
            { suggestionId: 'sug-1', user: harness.user },
            harness.deps
          ),
        (err) => err.status === 400 && err.code === 'platform_not_supported'
      );
      assert.equal(harness.sendMedia.calls.length, 0);
      assert.equal(harness.sendText.calls.length, 0);
      assert.equal(harness.sendFourBasedMessage.calls.length, 0);
      assert.equal(harness.sendTelegramText.calls.length, 0);
    }
  });

  it('records a rule suggestion when edit-send changes the text', async () => {
    const harness = createSendHarness();
    await executeApprovedSend(
      { suggestionId: 'sug-1', text: 'hallo schatz', user: harness.user, edited: true },
      harness.deps
    );
    assert.equal(harness.ruleSuggestions.length, 1);
    assert.equal(harness.ruleSuggestions[0].beforeText, 'hallo');
    assert.equal(harness.ruleSuggestions[0].afterText, 'hallo schatz');
    assert.equal(harness.sendText.calls.length, 1);
  });

  it('does not record a rule suggestion when the edited text matches', async () => {
    const harness = createSendHarness();
    await executeApprovedSend(
      { suggestionId: 'sug-1', text: 'hallo', user: harness.user, edited: true },
      harness.deps
    );
    assert.equal(harness.ruleSuggestions.length, 0);
  });

  it('does not record a rule suggestion on approve without edit', async () => {
    const harness = createSendHarness();
    await executeApprovedSend(
      { suggestionId: 'sug-1', user: harness.user, edited: false },
      harness.deps
    );
    assert.equal(harness.ruleSuggestions.length, 0);
  });

  it('still sends when recording a rule suggestion throws', async () => {
    const harness = createSendHarness({
      maybeSuggestRuleFromEdit: async () => {
        throw new Error('brain down');
      },
    });
    const result = await executeApprovedSend(
      { suggestionId: 'sug-1', text: 'hallo schatz', user: harness.user, edited: true },
      harness.deps
    );
    assert.equal(result.messageId, 'msg-99');
    assert.equal(result.suggestion.status, 'sent');
  });

  it('does not mark read when send fails', async () => {
    const harness = createSendHarness({
      sendText: async () => {
        throw new Error('network down');
      },
    });
    await assert.rejects(
      () =>
        executeApprovedSend(
          { suggestionId: 'sug-1', user: harness.user },
          harness.deps
        ),
      (err) => err.status === 502 && err.code === 'send_failed'
    );
    assert.equal(harness.markMaloumRead.calls.length, 0);
    assert.equal(harness.markFourBasedReceived.calls.length, 0);
  });
});

describe('takeover blocks generate', () => {
  it('shouldSkipGenerate returns human_takeover', () => {
    assert.deepEqual(
      shouldSkipGenerate({ effectiveMode: MODES.HUMAN_TAKEOVER }),
      { skip: true, reason: 'human_takeover' }
    );
  });

  it('processIncomingMessage skips after human_takeover', async () => {
    let providerCalls = 0;
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      {
        pool: {},
        getAiFlags: async () => ({
          enabled: true,
          shadowAllowed: true,
          suggestAllowed: true,
          autoSendAllowed: false,
        }),
        loadCreatorSettings: async () => ({
          mode: MODES.HUMAN_TAKEOVER,
          paused: false,
        }),
        loadConversation: async () => ({
          id: 'conv-1',
          creatorId: 'cr-1',
          platform: 'maloum',
          platformChatId: 'chat-1',
          revision: 1,
          lastInboundPlatformMessageId: 'in-1',
        }),
        withConversationLock: async (_db, _key, fn) => fn(null),
        findInboundRun: async () => null,
        insertRun: async (row) => ({ ...row, id: 'run-skip' }),
        generateReply: async () => {
          providerCalls += 1;
          return { reply: 'nope' };
        },
      }
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'human_takeover');
    assert.equal(providerCalls, 0);
  });

  it('takeover allows ai.moderate or ai.settings.manage', () => {
    const mw = requirePermission('ai.moderate', 'ai.settings.manage');
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.moderate'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);

    const denied = mockRes();
    let deniedNext = false;
    mw(
      { user: { role: 'chatter', permissions: ['ai.suggest.use'] } },
      denied,
      () => {
        deniedNext = true;
      }
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(deniedNext, false);
  });
});
