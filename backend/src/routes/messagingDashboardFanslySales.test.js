const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FANSLY_TRANSACTION_STATUS } = require('../services/fanslyClient');
const {
  isFanslyFalseSendSale,
  classifyFanslyWalletTransaction,
  shouldClearUnmatchedFanslySale,
} = require('./messagingDashboard');

const sentAt = '2026-10-07T05:52:35.000Z';
const onSend = '2026-10-07T05:52:43.000Z';
const later = '2026-10-07T08:15:00.000Z';

function send(overrides = {}) {
  return {
    id: 'row-1',
    platform: 'fansly',
    contentType: 'chat_product',
    purchased: true,
    payoutTxnId: null,
    maloumMessageId: '964094311182381056',
    chatId: 'chat-1',
    sentAt,
    unlockedAt: onSend,
    ...overrides,
  };
}

describe('fansly false send sales', () => {
  it('clears a sale marked within two minutes of send', () => {
    assert.equal(isFanslyFalseSendSale(send(), []), true);
  });

  it('keeps a purchase whose unlock time is the later notification', () => {
    assert.equal(isFanslyFalseSendSale(send({ unlockedAt: later }), []), false);
  });

  it('keeps notification-only sale rows and payout matches', () => {
    assert.equal(
      isFanslyFalseSendSale(send({ maloumMessageId: 'fansly-sale:1', unlockedAt: onSend }), []),
      false
    );
    assert.equal(
      isFanslyFalseSendSale(send({ maloumMessageId: 'fansly-tip:1', unlockedAt: onSend }), []),
      false
    );
    assert.equal(isFanslyFalseSendSale(send({ payoutTxnId: 'txn-1' }), []), false);
  });

  it('clears a thread-load stamp shared by sends made minutes apart', () => {
    const first = send({
      id: 'old',
      maloumMessageId: '1',
      sentAt: '2026-10-01T00:00:00.000Z',
      unlockedAt: later,
    });
    const second = send({
      id: 'new',
      maloumMessageId: '2',
      sentAt: '2026-10-07T00:00:00.000Z',
      unlockedAt: '2026-10-07T08:15:00.400Z',
    });
    assert.equal(isFanslyFalseSendSale(first, [first, second]), true);
    assert.equal(isFanslyFalseSendSale(second, [first, second]), true);
  });

  it('keeps one later unlock that is not shared with another send', () => {
    const real = send({ id: 'real', unlockedAt: later });
    const otherChat = send({
      id: 'other',
      chatId: 'chat-2',
      sentAt: '2026-10-01T00:00:00.000Z',
      unlockedAt: later,
    });
    assert.equal(isFanslyFalseSendSale(real, [real, otherChat]), false);
  });
});

describe('fansly wallet transaction classification', () => {
  const soldAt = 1790000000;

  it('treats a pending incoming media sale as an unverified sale', () => {
    const row = classifyFanslyWalletTransaction({
      transactionId: '962553777712287745',
      type: 2110,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.PENDING,
      correlationId: '955433488562024448',
      correlationAccountId: '879702847782936576',
      amount: 5000,
      createdAt: soldAt,
    });
    assert.equal(row.action, 'sale');
    assert.equal(row.verified, false);
    assert.equal(row.contentId, '955433488562024448');
    assert.equal(row.fanId, '879702847782936576');
    assert.equal(row.net, 5);
  });

  it('treats an approved bundle sale as verified', () => {
    const row = classifyFanslyWalletTransaction({
      transactionId: '962553777712287746',
      type: 2116,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.APPROVED,
      correlationId: '11',
      correlationAccountId: '22',
      amount: 10000,
      createdAt: soldAt,
    });
    assert.equal(row.action, 'sale');
    assert.equal(row.verified, true);
  });

  it('clears refunded and outgoing rows', () => {
    const refunded = classifyFanslyWalletTransaction({
      transactionId: '30',
      type: 2110,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.REFUNDED,
      amount: 5000,
      createdAt: soldAt,
    });
    const outgoing = classifyFanslyWalletTransaction({
      transactionId: '31',
      type: 2110,
      destination: 1,
      status: FANSLY_TRANSACTION_STATUS.APPROVED,
      amount: 5000,
      createdAt: soldAt,
    });
    const refundDebit = classifyFanslyWalletTransaction({
      transactionId: '32',
      type: 6101,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.APPROVED,
      correlationId: '30',
      amount: 5000,
      createdAt: soldAt,
    });
    assert.equal(refunded.action, 'clear');
    assert.equal(outgoing.action, 'clear');
    assert.equal(refundDebit.action, 'clear');
    assert.equal(refundDebit.correlationId, '30');
  });

  it('skips subscriptions and keeps tips', () => {
    const subscription = classifyFanslyWalletTransaction({
      transactionId: '40',
      type: 15001,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.APPROVED,
      correlationAccountId: '22',
      amount: 10000,
      createdAt: soldAt,
    });
    const tip = classifyFanslyWalletTransaction({
      transactionId: '41',
      type: 7101,
      destination: 2,
      status: FANSLY_TRANSACTION_STATUS.PENDING,
      correlationId: '77',
      correlationAccountId: '22',
      amount: 3000,
      createdAt: soldAt,
    });
    assert.equal(subscription.action, 'skip');
    assert.equal(tip.action, 'tip');
    assert.equal(tip.verified, false);
    assert.equal(tip.correlationId, '77');
  });
});

describe('fansly wallet unmatched sale window', () => {
  const inside = '2026-10-18T00:00:00.000Z';
  const outside = '2026-01-01T00:00:00.000Z';
  const windowStartMs = Date.parse('2026-10-10T00:00:00.000Z');

  function sale(overrides = {}) {
    return {
      platform: 'fansly',
      contentType: 'chat_product',
      purchased: true,
      payoutTxnId: null,
      unlockedAt: inside,
      sentAt: inside,
      ...overrides,
    };
  }

  it('clears an unmatched sale inside the fetched window', () => {
    assert.equal(shouldClearUnmatchedFanslySale(sale(), { windowStartMs }), true);
  });

  it('keeps an unmatched sale older than a capped walk', () => {
    assert.equal(
      shouldClearUnmatchedFanslySale(sale({ unlockedAt: outside, sentAt: outside }), { windowStartMs }),
      false
    );
  });

  it('clears older unmatched sales when the ledger walk reached the end', () => {
    assert.equal(
      shouldClearUnmatchedFanslySale(sale({ unlockedAt: outside, sentAt: outside }), {
        reachedEnd: true,
        windowStartMs,
      }),
      true
    );
  });

  it('keeps a row the wallet already claimed', () => {
    assert.equal(
      shouldClearUnmatchedFanslySale(sale({ payoutTxnId: '962553777712287745' }), {
        reachedEnd: true,
      }),
      false
    );
  });
});
