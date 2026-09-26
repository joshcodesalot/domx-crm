const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchCommentText, GUARD_TERMS } = require('./maloumCommentGuard');
const { maloumThrottleWaitMs } = require('./maloumClient');

describe('maloumCommentGuard matchCommentText', () => {
  it('matches whole-word AI and KI regardless of case', () => {
    assert.equal(matchCommentText('this is AI'), 'AI');
    assert.equal(matchCommentText('sounds like ai.'), 'AI');
    assert.equal(matchCommentText('KI generiert'), 'KI');
    assert.equal(matchCommentText('das ist ki!'), 'KI');
  });

  it('matches dotted A.I. and K.I.', () => {
    assert.equal(matchCommentText('made by A.I.'), 'A.I.');
    assert.equal(matchCommentText('K.I. bild'), 'K.I.');
  });

  it('does not match those letters inside other words', () => {
    assert.equal(matchCommentText('she said hello'), null);
    assert.equal(matchCommentText('Kind und Kissen'), null);
    assert.equal(matchCommentText('Bikini am Strand'), null);
    assert.equal(matchCommentText('available again'), null);
    assert.equal(matchCommentText('email paid wait'), null);
  });

  it('ignores empty text', () => {
    assert.equal(matchCommentText(''), null);
    assert.equal(matchCommentText('   '), null);
    assert.equal(matchCommentText(null), null);
  });

  it('keeps the guard terms stable', () => {
    assert.deepEqual(GUARD_TERMS, ['AI', 'KI', 'A.I.', 'K.I.']);
  });
});

describe('maloumThrottleWaitMs', () => {
  it('waits for the window named in a getComments throttle', () => {
    assert.equal(
      maloumThrottleWaitMs({
        message:
          'Throttled five-seconds-herrin_lea-PostsController-getComments on PostsController in method getComments',
      }),
      5000
    );
    assert.equal(
      maloumThrottleWaitMs({
        message: 'Throttled thirty-seconds-herrin_lea-PostsController-getComments',
      }),
      30000
    );
    assert.equal(
      maloumThrottleWaitMs({
        message: 'Throttled sixty-seconds-herrin_lea-PostsController-getComments',
      }),
      60000
    );
  });

  it('defaults to the five-second window', () => {
    assert.equal(maloumThrottleWaitMs({ message: 'Throttled' }), 5000);
    assert.equal(maloumThrottleWaitMs({ status: 429 }), 5000);
  });
});
