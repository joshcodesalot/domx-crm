const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_GAP_THRESHOLD_HOURS,
  SUMMARY_TOTAL_CHARS,
  planSessionSummary,
  formatSessionSummary,
  maybeWriteSessionSummary,
} = require('./summary');

function atHours(hours) {
  return new Date(Date.UTC(2026, 8, 8, 0, 0, 0) + hours * 36e5).toISOString();
}

function msg(id, hours, extras = {}) {
  return {
    platformMessageId: id,
    direction: extras.direction || 'inbound',
    senderRole: extras.senderRole || (extras.direction === 'outbound' ? 'creator' : 'fan'),
    text: extras.text ?? `text ${id}`,
    sentAt: atHours(hours),
    ...extras,
  };
}

function createSummaryStore() {
  const rows = [];
  return {
    rows,
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('INSERT INTO ai_conversation_summaries')) {
        const [conversationId, uptoPlatformMessageId, uptoSentAt, gapHours, summary] =
          params;
        const exists = rows.some(
          (row) =>
            row.conversationId === conversationId &&
            row.uptoPlatformMessageId === uptoPlatformMessageId
        );
        if (!exists) {
          rows.push({
            id: `sum-${rows.length + 1}`,
            conversationId,
            uptoPlatformMessageId,
            uptoSentAt,
            gapHours,
            summary,
            createdAt: new Date().toISOString(),
          });
        }
        return { rows: [] };
      }
      if (text.includes('FROM ai_conversation_summaries')) {
        const conversationId = params[0];
        const latest = rows
          .filter((row) => row.conversationId === conversationId)
          .slice()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        return { rows: latest ? [{ summary: latest.summary }] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('planSessionSummary', () => {
  it('writes when the inbound gap is above 12 hours', () => {
    const plan = planSessionSummary([
      msg('old-1', 0, { text: 'yesterday hi' }),
      msg('old-2', 0.1, { direction: 'outbound', text: 'yesterday reply' }),
      msg('new-1', 13, { text: 'hello again' }),
    ]);
    assert.equal(plan.shouldWrite, true);
    assert.ok(plan.gapHours > SESSION_GAP_THRESHOLD_HOURS);
    assert.equal(plan.uptoPlatformMessageId, 'old-2');
    assert.equal(plan.previousMessages.length, 2);
  });

  it('does not write when the gap is 2 hours', () => {
    const plan = planSessionSummary([
      msg('old-1', 0, { text: 'earlier' }),
      msg('new-1', 2, { text: 'soon after' }),
    ]);
    assert.equal(plan.shouldWrite, false);
  });
});

describe('formatSessionSummary', () => {
  it('clamps line and total length', () => {
    const long = 'x'.repeat(400);
    const formatted = formatSessionSummary(
      Array.from({ length: 30 }, (_, i) =>
        msg(`m${i}`, i, { text: long, direction: i % 2 ? 'outbound' : 'inbound' })
      ),
      13
    );
    assert.ok(formatted.startsWith('Previous session (~13h gap):'));
    assert.ok(formatted.length <= SUMMARY_TOTAL_CHARS);
    assert.equal(formatted.includes('password'), false);
  });
});

describe('maybeWriteSessionSummary', () => {
  it('writes once per uptoPlatformMessageId', async () => {
    const store = createSummaryStore();
    const messages = [
      msg('old-1', 0, { text: 'yesterday' }),
      msg('new-1', 13, { text: 'back' }),
    ];
    const first = await maybeWriteSessionSummary(
      { conversationId: 'conv-1', messages },
      store
    );
    const second = await maybeWriteSessionSummary(
      { conversationId: 'conv-1', messages },
      store
    );
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].uptoPlatformMessageId, 'old-1');
    assert.equal(typeof first, 'string');
    assert.equal(second, first);
    assert.match(first, /yesterday/);
  });
});
