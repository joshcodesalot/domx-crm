const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  RECENT_ACTIVE_LIMIT,
  listRecentActiveConversations,
} = require('./recentActiveSafety');

describe('listRecentActiveConversations', () => {
  it('skips already-fetched chats and caps the page', async () => {
    const client = {
      async query(sql, params) {
        assert.match(sql, /ai_conversations/);
        assert.equal(params[0], 'cr-1');
        assert.equal(params[1], 'telegram');
        return {
          rows: [
            { platformChatId: '111', platformFanId: '111', fanUsername: 'a' },
            { platformChatId: '222', platformFanId: '222', fanUsername: 'b' },
            { platformChatId: '333', platformFanId: '333', fanUsername: 'c' },
          ],
        };
      },
    };
    const rows = await listRecentActiveConversations(
      {
        creatorId: 'cr-1',
        platform: 'telegram',
        skipChatIds: ['111'],
        limit: 1,
      },
      client
    );
    assert.deepEqual(
      rows.map((row) => row.platformChatId),
      ['222']
    );
    assert.ok(RECENT_ACTIVE_LIMIT >= 1);
  });

  it('returns none without creator or platform', async () => {
    const rows = await listRecentActiveConversations({ creatorId: 'cr-1' });
    assert.deepEqual(rows, []);
  });
});
