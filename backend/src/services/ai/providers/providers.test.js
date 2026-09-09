const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResponse } = require('./mockProvider');
const { extractJsonObject } = require('./jsonExtract');

describe('mockProvider.createResponse', () => {
  it('returns the given output text without a network call', async () => {
    const result = await createResponse({
      outputText: '{"rapport":"hi","upsell":"hey"}',
    });
    assert.equal(result.outputText, '{"rapport":"hi","upsell":"hey"}');
  });

  it('coerces missing output to an empty string', async () => {
    const result = await createResponse({});
    assert.equal(result.outputText, '');
  });
});

describe('extractJsonObject', () => {
  it('parses a valid object', () => {
    assert.deepEqual(extractJsonObject('{"rapport":"a","upsell":"b"}'), {
      rapport: 'a',
      upsell: 'b',
    });
  });

  it('extracts an object buried in prose', () => {
    assert.deepEqual(
      extractJsonObject('Here you go:\n{"rapport":"a","upsell":"b"}\nthanks'),
      { rapport: 'a', upsell: 'b' }
    );
  });

  it('unwraps fenced JSON', () => {
    assert.deepEqual(
      extractJsonObject('```json\n{"rapport":"a","upsell":"b"}\n```'),
      { rapport: 'a', upsell: 'b' }
    );
  });

  it('returns null for empty or invalid text', () => {
    assert.equal(extractJsonObject(''), null);
    assert.equal(extractJsonObject('   '), null);
    assert.equal(extractJsonObject('not json'), null);
    assert.equal(extractJsonObject('{'), null);
  });
});
