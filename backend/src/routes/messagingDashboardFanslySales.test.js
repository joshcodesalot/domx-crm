const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isFanslyFalseSendSale } = require('./messagingDashboard');

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
