const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BUMP_RECENT_MS,
  berlinDayPart,
  berlinStamp,
  bumpSkipReason,
  buildBumpInput,
  bumpErrorAction,
  cleanBumpText,
  generateBump,
  isRecentChat,
} = require('./telegramBumpCopy');
const xai = require('./xaiClient');

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

describe('german time of day', () => {
  it('names the Berlin hour as morning, day, evening, or night', () => {
    assert.equal(berlinDayPart('2026-11-01T03:00:00.000Z'), 'night');
    assert.equal(berlinDayPart('2026-11-01T04:00:00.000Z'), 'morning');
    assert.equal(berlinDayPart('2026-11-01T09:59:00.000Z'), 'morning');
    assert.equal(berlinDayPart('2026-11-01T10:00:00.000Z'), 'day');
    assert.equal(berlinDayPart('2026-11-01T15:00:00.000Z'), 'day');
    assert.equal(berlinDayPart('2026-11-01T16:00:00.000Z'), 'evening');
    assert.equal(berlinDayPart('2026-11-01T20:59:00.000Z'), 'evening');
    assert.equal(berlinDayPart('2026-11-01T21:00:00.000Z'), 'night');
    assert.equal(berlinDayPart(NOW), 'night');
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
    assert.match(input[0].content, /She is always a femdom woman/);
    assert.match(input[0].content, /model \(you already sent this\)/);
    assert.match(input[0].content, /fan \(he sent this\)/);
    assert.match(input[0].content, /Never answer a model line, and never treat it as something the fan said/);
    assert.match(input[0].content, /Do not reply to her own question/);
    assert.match(input[0].content, /When the user message says the thread is stale/);
    assert.match(input[0].content, /Never call the fan Herrin, Mistress/);
    assert.match(input[0].content, /If none of her lines name him, do not call him anything/);
    assert.match(input[0].content, /Never call the fan by his Telegram username or @handle/);
    assert.match(input[0].content, /Do not paste an example unchanged/);
    assert.doesNotMatch(input[0].content, /so, da bin ich wieder/);
    assert.doesNotMatch(input[1].content, /so, da bin ich wieder/);
    assert.match(input[0].content, /Do not become more dominant, softer, or switch character/);
    assert.match(input[0].content, /not like an AI assistant/);
    assert.match(input[0].content, /Do not ask a question in every message/);
    assert.match(input[0].content, /Do not force flirting, domination, or selling onto it/);
    assert.match(input[0].content, /A pet name from the notes is not enough/);
    assert.match(input[0].content, /not the opening of a new session/);
    assert.match(input[0].content, /No greeting of any kind/);
    assert.match(input[0].content, /Guten Morgen, Guten Tag, Guten Abend/);
    assert.match(input[0].content, /If the fan sent the last message, answer that message/);
    assert.match(input[0].content, /If the model sent the last message, do not repeat her last line/);
    assert.match(input[0].content, /Do not announce the hour or the gap/);
    assert.doesNotMatch(input[0].content, /unless the named German part of day actually calls for/);
    assert.match(input[0].content, /Write in the language of the recent chat/);
    assert.match(input[0].content, /If the history has no written text, write German/);
    assert.doesNotMatch(input[0].content, /Output only the German message/);
    assert.match(input[1].content, /Current time in Germany: 01\.11\.2026 02:53 \(night\)/);
    assert.match(
      input[1].content,
      /Last message: model at 01\.11\.2026 00:55 German time, 2 hours ago/
    );
    assert.match(input[1].content, /Write the message in the chat language/);
    assert.doesNotMatch(input[1].content, /Write the German message/);
    assert.match(input[1].content, /\[01\.11\.2026 00:53, German time\] fan \(he sent this\): hey/);
    assert.match(input[1].content, /\[01\.11\.2026 00:55, German time\] model \(you already sent this\): \(photo\)/);
    assert.doesNotMatch(input[1].content, /This thread is stale/);
    assert.match(input[1].content, /Location: Berlin/);
    assert.doesNotMatch(input[1].content, /Fetishes \/ Kinks:\s*$/m);

    const fanLast = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T23:53:00.000Z',
          text: 'hey',
          isOutgoing: false,
        },
      ],
    });
    assert.match(
      fanLast[1].content,
      /Last message: fan at 01\.11\.2026 00:53 German time, 2 hours ago/
    );

    const minutesAgo = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: new Date(NOW - 30 * 60 * 1000).toISOString(),
          text: 'hey',
          isOutgoing: false,
        },
      ],
    });
    assert.match(
      minutesAgo[1].content,
      /Last message: fan at 01\.11\.2026 02:23 German time, 30 minutes ago/
    );

    const daysAgo = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
          text: 'hey',
          isOutgoing: true,
        },
      ],
    });
    assert.match(
      daysAgo[1].content,
      /Last message: model at 29\.10\.2026 02:53 German time, 3 days ago/
    );

    const none = buildBumpInput({ now: new Date(NOW), messages: [] });
    assert.match(none[1].content, /Last message: there is no last message/);
  });
});

describe('bump speakers', () => {
  const question = 'ich habe eine Frage';

  it('labels her question as hers, including when only her sender id matches', () => {
    const outgoing = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T23:55:00.000Z',
          text: question,
          isOutgoing: true,
        },
      ],
    });
    assert.match(
      outgoing[1].content,
      /model \(you already sent this\): ich habe eine Frage/
    );
    assert.doesNotMatch(outgoing[1].content, /fan \(he sent this\): ich habe eine Frage/);

    const bySender = buildBumpInput({
      now: new Date(NOW),
      selfId: '42',
      messages: [
        {
          date: '2026-10-31T23:55:00.000Z',
          text: question,
          isOutgoing: false,
          senderId: '42',
        },
      ],
    });
    assert.match(bySender[1].content, /Last message: model at 01\.11\.2026 00:55/);
    assert.match(
      bySender[1].content,
      /model \(you already sent this\): ich habe eine Frage/
    );
  });

  it('leaves a deleted message out of the transcript and the last-message line', () => {
    const input = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T20:53:00.000Z',
          text: 'hey',
          isOutgoing: false,
        },
        {
          date: '2026-10-31T23:55:00.000Z',
          text: 'deleted question',
          isOutgoing: true,
          deleted: true,
        },
      ],
    });
    assert.doesNotMatch(input[1].content, /deleted question/);
    assert.match(input[1].content, /Last message: fan at 31\.10\.2026 21:53/);
    assert.equal(
      isRecentChat(
        [
          {
            date: new Date(NOW - 3 * BUMP_RECENT_MS).toISOString(),
            text: 'old',
            isOutgoing: false,
          },
          {
            date: new Date(NOW - 60_000).toISOString(),
            text: 'gone',
            deleted: true,
          },
        ],
        NOW
      ),
      false
    );
  });

  it('asks for a new opener only after the last message is older than 2 days', () => {
    const exact = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
          text: 'alte frage',
          isOutgoing: false,
        },
      ],
    });
    assert.doesNotMatch(exact[1].content, /This thread is stale/);

    const older = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: new Date(NOW - 2 * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
          text: 'alte frage',
          isOutgoing: false,
        },
      ],
    });
    assert.match(
      older[1].content,
      /This thread is stale\. Send a new opener and do not continue the old topic/
    );
    assert.match(older[1].content, /fan \(he sent this\): alte frage/);
  });
});

describe('bump model', () => {
  it('calls the xAI client and stops when that key is missing', async () => {
    const original = xai.createResponse;
    let called = 0;
    xai.createResponse = async () => {
      called += 1;
      return { outputText: 'Das Foto von gestern war gut.' };
    };
    try {
      const text = await generateBump({ notes: '', messages: [], now: new Date(NOW) });
      assert.equal(called, 1);
      assert.equal(text, 'Das Foto von gestern war gut.');
    } finally {
      xai.createResponse = original;
    }
    assert.equal(bumpErrorAction(new Error('XAI_API_KEY is not set')).action, 'stop');
  });
});

describe('bump language', () => {
  it('keeps German samples for a German chat and leaves them out of an English chat', () => {
    const english = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T23:53:00.000Z',
          text: 'whats the price on your mind',
          isOutgoing: true,
        },
      ],
    });
    const englishPrompt = english.map((part) => part.content).join('\n');
    assert.match(englishPrompt, /The recent chat is English\. Write one short line in English only/);
    assert.doesNotMatch(englishPrompt, /so, da bin ich wieder/);

    const german = buildBumpInput({
      now: new Date(NOW),
      messages: [
        {
          date: '2026-10-31T23:53:00.000Z',
          text: 'ich bin gerade zuhause',
          isOutgoing: false,
        },
      ],
    });
    const germanPrompt = german.map((part) => part.content).join('\n');
    assert.match(germanPrompt, /The recent chat is German\. Write in German/);
    assert.doesNotMatch(germanPrompt, /so, da bin ich wieder/);
    assert.match(germanPrompt, /was machst du gerade\?/);
  });

  it('drops a copied German sample from an English chat and keeps an English opener', () => {
    const english = [
      {
        date: '2026-10-31T23:53:00.000Z',
        text: 'what are you doing',
        isOutgoing: false,
      },
    ];
    assert.equal(cleanBumpText('so, da bin ich wieder 😊', english), '');
    const german = [
      {
        date: '2026-10-31T23:53:00.000Z',
        text: 'ich bin gerade zuhause',
        isOutgoing: false,
      },
    ];
    assert.equal(cleanBumpText('so, da bin ich wieder', german), '');
    assert.equal(
      cleanBumpText('Ich hab an das Foto von gestern gedacht.', german),
      'Ich hab an das Foto von gestern gedacht.'
    );
    assert.equal(
      cleanBumpText('What are you doing right now?', english),
      'What are you doing right now?'
    );
  });
});

describe('bump greeting strip', () => {
  it('drops a leading greeting and keeps the follow-up', () => {
    assert.equal(
      cleanBumpText('Guten Morgen, mein Schatz. Wie war das Foto?'),
      'Wie war das Foto?'
    );
    assert.equal(
      cleanBumpText('Good morning, that photo is still here.'),
      'That photo is still here.'
    );
    assert.equal(
      cleanBumpText('Hey, das Foto von gestern war gut.'),
      'Das Foto von gestern war gut.'
    );
    assert.equal(
      cleanBumpText('Hallo, ich hab an das Foto gedacht.'),
      'Ich hab an das Foto gedacht.'
    );
    assert.equal(cleanBumpText('Guten Morgen'), '');
    assert.equal(cleanBumpText('Hey!'), '');
  });
});
