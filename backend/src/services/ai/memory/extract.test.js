const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExtracted,
  mergeAiNotesBlock,
  buildAiNotesBlock,
  AI_NOTES_MARKER,
} = require('./extract');

describe('memory extract helpers', () => {
  it('does not treat username as givenName', () => {
    const extracted = normalizeExtracted(
      {
        givenName: 'sugar_daddy99',
        facts: [{ kind: 'name', text: 'sugar_daddy99' }],
      },
      { username: 'sugar_daddy99' }
    );
    assert.equal(extracted.givenName, null);
  });

  it('appends an AI notes block without wiping chatter notes', () => {
    const block = buildAiNotesBlock({
      givenName: 'Alex',
      facts: [{ kind: 'preference', text: 'voice notes' }],
    });
    assert.match(block, new RegExp(AI_NOTES_MARKER));
    const merged = mergeAiNotesBlock('Likes late chats', block);
    assert.match(merged, /Likes late chats/);
    assert.match(merged, /Name: Alex/);
    const replaced = mergeAiNotesBlock(merged, `${AI_NOTES_MARKER}\nName: Alex\nKinks: leather`);
    assert.equal(replaced.startsWith('Likes late chats'), true);
    assert.match(replaced, /leather/);
    assert.equal((replaced.match(new RegExp(AI_NOTES_MARKER, 'g')) || []).length, 1);
  });
});
