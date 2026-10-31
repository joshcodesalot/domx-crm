const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BUMP_RECENT_MS,
  berlinStamp,
  bumpSkipReason,
  buildBumpInput,
  isRecentChat,
} = require('./telegramBumpCopy');

const NOW = Date.parse('2026-11-01T01:53:00.000Z');

describe('telegram bump skip', () => {
  it('skips a chat whose newest message is under 2 hours old', () => {
    const messages = [{ date: new Date(NOW - 60 * 60 * 1000).toISOString(), text: 'hey', isOutgoing: false }];
    assert.equal(isRecentChat(messages, NOW), true);
    assert.equal(
      bumpSkipReason({ kind: 'dm', messages, nowMs: NOW }),
      'Recent conversation'
    );
  });

  it('keeps a chat whose newest message is 2 hours old or older', () => {
    const exact = [{ date: new Date(NOW - BUMP_RECENT_MS).toISOString(), text: 'hey', isOutgoing: false }];
    const older = [{ date: new Date(NOW - BUMP_RECENT_MS - 60_000).toISOString(), text: 'hey', isOutgoing: true }];
    assert.equal(isRecentChat(exact, NOW), false);
    assert.equal(bumpSkipReason({ kind: 'dm', messages: exact, nowMs: NOW }), null);
    assert.equal(bumpSkipReason({ kind: 'dm', messages: older, nowMs: NOW }), null);
  });

  it('skips a group or unmessageable fan before any copy is written', () => {
    const quiet = [{ date: new Date(NOW - 3 * BUMP_RECENT_MS).toISOString(), text: 'old', isOutgoing: false }];
    assert.equal(bumpSkipReason({ kind: 'group', messages: quiet, nowMs: NOW }), 'Group chat');
    assert.equal(
      bumpSkipReason({ kind: 'dm', messageable: false, messages: quiet, nowMs: NOW }),
      'Not messageable'
    );
    assert.equal(
      bumpSkipReason({ kind: 'dm', service: true, messages: quiet, nowMs: NOW }),
      'Service chat'
    );
    const liveGroup = [{ date: new Date(NOW - 60_000).toISOString(), text: 'hi', isOutgoing: false }];
    assert.equal(bumpSkipReason({ kind: 'group', messages: liveGroup, nowMs: NOW }), 'Group chat');
  });
});

describe('telegram bump prompt', () => {
  it('stamps the chat and the current time in Germany and keeps dominance steady', () => {
    assert.equal(berlinStamp(NOW), '01.11.2026 02:53');
    const input = buildBumpInput({
      notes: '🖤 Fetishes / Kinks:\n📍 Location: Berlin',
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T23:53:00.000Z',
          text: 'hey',
          isOutgoing: false,
        },
        {
          date: '2026-10-31T23:55:00.000Z',
          text: '',
          placeholder: 'Photo',
          kind: 'photo',
          isOutgoing: true,
        },
      ],
    });
    assert.match(input[0].content, /Do not become more dominant, softer, or switch character/);
    assert.match(input[1].content, /Current time in Germany: 01\.11\.2026 02:53/);
    assert.match(input[1].content, /\[01\.11\.2026 00:53\] fan: hey/);
    assert.match(input[1].content, /\[01\.11\.2026 00:55\] creator: \(photo\)/);
    assert.match(input[1].content, /Location: Berlin/);
    assert.doesNotMatch(input[1].content, /Fetishes \/ Kinks:\s*$/m);
  });
});
