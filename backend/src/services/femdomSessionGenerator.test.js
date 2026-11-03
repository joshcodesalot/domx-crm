const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSessionInput,
  blocksRepeat,
  repeatedBlocks,
} = require('./femdomSessionGenerator');

const STAMPED = '2026-10-31T23:53:00.000Z';
const COPIED_TASK =
  'Lil Pisa, ich will, dass du den Dildo noch tiefer in deinen Arsch schiebst. Ich will, dass du dich ganz entspannst und dich auf das Gefühl konzentrierst. Du wirst nicht kommen, verstanden? Ich will, dass du dich an den Rand bringst, aber nicht darüber hinaus. Zeig mir, wie sehr du es liebst, mir zu gefallen. Ich will, dass du dich ganz entspannst und dich auf das Gefühl konzentrierst.';

const KNEEL = [
  'Kneel and put your hands behind your back.',
  'Hold still until I speak.',
  'Look at the floor.',
  'Breathe slowly through your nose.',
  'Do not touch yourself.',
  'Answer me when I say your name.',
].join('\n');

const TURN = [
  'Turn onto your stomach.',
  'Spread your knees apart.',
  'Count each slap out loud.',
  'Stay quiet between them.',
  'Keep both palms flat on the bed.',
  'Wait for the next one before you move.',
].join('\n');

function userText(input) {
  return input[1].content;
}

describe('sexting session prompt', () => {
  it('keeps the last 40 messages, the notes, and drops anything older', () => {
    const messages = Array.from({ length: 45 }, (_, index) => ({
      date: STAMPED,
      text: `history-line-${String(index).padStart(2, '0')}`,
      isOutgoing: index % 2 === 0,
    }));
    const input = buildSessionInput({
      slaveName: 'Lil Pisa',
      speakerNames: ['Natalia'],
      notes: 'Limit: no choking\nEmpty:\nName: Lil Pisa',
      messages,
      chatKind: 'dm',
      total: 20,
      startIndex: 1,
      batchCount: 5,
    });
    const user = userText(input);
    assert.match(input[0].content, /Write in the language of the recent chat/);
    assert.doesNotMatch(input[0].content, /The chat has no written text/);
    assert.match(user, /history-line-05/);
    assert.match(user, /history-line-44/);
    assert.match(user, /\[01\.11\.2026 00:53, German time\] creator: history-line-44/);
    assert.match(user, /\[01\.11\.2026 00:53, German time\] fan: history-line-05/);
    assert.doesNotMatch(user, /history-line-00/);
    assert.doesNotMatch(user, /history-line-04/);
    assert.match(user, /Limit: no choking/);
    assert.match(user, /Name: Lil Pisa/);
    assert.doesNotMatch(user, /^Empty:\s*$/m);
    assert.match(user, /Write these blocks in the chat language/);
    assert.match(input[0].content, /Each block is one new task for this fan/);
    assert.match(input[0].content, /Changing one word is still a repeat/);
  });

  it('labels a direct chat as creator and fan even when a sender name is present', () => {
    const input = buildSessionInput({
      speakerNames: ['Natalia'],
      messages: [
        {
          date: STAMPED,
          text: 'deeper',
          isOutgoing: false,
          senderName: 'Natalia',
        },
      ],
      chatKind: 'dm',
      batchCount: 1,
      total: 1,
    });
    const user = userText(input);
    assert.match(user, /fan: deeper/);
    assert.doesNotMatch(user, /Natalia: deeper/);
  });

  it('labels group messages with the sender name', () => {
    const input = buildSessionInput({
      speakerNames: ['Natalia', 'Mara'],
      messages: [
        {
          date: STAMPED,
          text: 'deeper',
          isOutgoing: false,
          senderName: 'Natalia',
        },
        {
          date: STAMPED,
          text: 'slower',
          isOutgoing: true,
          senderName: 'Mara',
        },
      ],
      chatKind: 'group',
      startIndex: 6,
      batchCount: 2,
      total: 20,
      priorBlocks: [{ index: 5, speaker: 'Natalia', text: KNEEL }],
    });
    const user = userText(input);
    assert.match(user, /Natalia: deeper/);
    assert.match(user, /Mara: slower/);
    assert.doesNotMatch(user, /fan: deeper/);
    assert.match(user, /6\. Mara/);
    assert.match(user, /7\. Natalia/);
    assert.match(user, /Block 5 \(Natalia\):/);
    assert.match(user, /Kneel and put your hands behind your back/);
    assert.match(input[0].content, /indexes 6 through 7/);
    assert.match(input[0].content, /Do not restart the rotation/);
  });

  it('writes English when the recent chat has no written text', () => {
    const input = buildSessionInput({
      speakerNames: ['Natalia'],
      messages: [
        {
          date: STAMPED,
          text: '',
          placeholder: 'Photo',
          kind: 'photo',
          isOutgoing: true,
        },
      ],
      batchCount: 1,
      total: 1,
    });
    const user = userText(input);
    assert.match(user, /creator: \(photo\)/);
    assert.match(user, /Write these blocks in English/);
    assert.doesNotMatch(user, /Write these blocks in the chat language/);
    assert.match(input[0].content, /The chat has no written text\. Write in English/);
  });

  it('includes a failed batch once, without repeating the same forbidden text', () => {
    const input = buildSessionInput({
      speakerNames: ['Natalia'],
      messages: [{ date: STAMPED, text: 'weiter', isOutgoing: false }],
      batchCount: 1,
      total: 1,
      forbiddenTexts: [COPIED_TASK, `  ${COPIED_TASK}  `],
    });
    const user = userText(input);
    assert.match(user, /Do not write them again/);
    assert.match(user, /Forbidden 1:/);
    assert.doesNotMatch(user, /Forbidden 2:/);
    assert.match(user, /noch tiefer/);
  });
});

describe('sexting session duplicate check', () => {
  it('rejects the same task, a one-word edit, and a block that reuses most lines', () => {
    const edited = COPIED_TASK.replace('tiefer', 'fester');
    assert.equal(blocksRepeat(COPIED_TASK, COPIED_TASK.toUpperCase()), true);
    assert.equal(blocksRepeat(COPIED_TASK, edited), true);
    const shared = [
      'Hold your wrists behind your back.',
      'Do not move your hips.',
      'Keep your eyes down.',
      'Answer only when I ask.',
    ];
    const reused = [
      ...shared,
      'Count your breaths out loud.',
      'Stay on your knees.',
    ].join('\n');
    const alsoReused = [
      ...shared,
      'Name the toy in your hand.',
      'Spread your knees wider.',
    ].join('\n');
    assert.equal(blocksRepeat(reused, alsoReused), true);
    assert.deepEqual(
      repeatedBlocks([
        { index: 1, text: COPIED_TASK },
        { index: 2, text: edited },
        { index: 3, text: KNEEL },
      ]).map((block) => block.index),
      [2]
    );
  });

  it('keeps two different tasks', () => {
    assert.equal(blocksRepeat(KNEEL, TURN), false);
    assert.deepEqual(repeatedBlocks([
      { index: 1, text: KNEEL },
      { index: 2, text: TURN },
    ]), []);
  });
});
