const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractUsage,
  estimateCostUsd,
  normalizeUsage,
  upsertAiUsage,
  DEFAULT_INPUT_USD_PER_MTTOK,
  DEFAULT_OUTPUT_USD_PER_MTTOK,
} = require('./usage');

describe('extractUsage', () => {
  it('reads xAI input_tokens and output_tokens', () => {
    assert.deepEqual(
      extractUsage({ usage: { input_tokens: 100, output_tokens: 20 } }),
      { promptTokens: 100, completionTokens: 20 }
    );
  });

  it('accepts prompt_tokens aliases', () => {
    assert.deepEqual(
      extractUsage({ usage: { prompt_tokens: 8, completion_tokens: 3 } }),
      { promptTokens: 8, completionTokens: 3 }
    );
  });

  it('returns null without a usage object', () => {
    assert.equal(extractUsage({ outputText: 'hi' }), null);
    assert.equal(extractUsage(null), null);
  });
});

describe('estimateCostUsd', () => {
  it('is deterministic from default per-million rates', () => {
    const cost = estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000 });
    assert.equal(cost, DEFAULT_INPUT_USD_PER_MTTOK + DEFAULT_OUTPUT_USD_PER_MTTOK);
  });

  it('scales linearly for smaller counts', () => {
    const cost = estimateCostUsd({ promptTokens: 1000, completionTokens: 0 });
    assert.equal(cost, Number((DEFAULT_INPUT_USD_PER_MTTOK / 1000).toFixed(8)));
  });
});

describe('upsertAiUsage', () => {
  it('upserts on runId conflict with updated tokens and cost', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              runId: params[0],
              creatorId: params[1],
              promptTokens: params[4],
              completionTokens: params[5],
              costUsd: params[6],
            },
          ],
        };
      },
    };

    const first = await upsertAiUsage(
      {
        runId: 'run-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        mode: 'shadow',
        promptTokens: 10,
        completionTokens: 4,
        costUsd: 0.01,
      },
      client
    );
    const second = await upsertAiUsage(
      {
        runId: 'run-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        mode: 'shadow',
        promptTokens: 40,
        completionTokens: 12,
        costUsd: 0.05,
      },
      client
    );

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /ON CONFLICT \("runId"\) DO UPDATE/);
    assert.equal(first.promptTokens, 10);
    assert.equal(second.promptTokens, 40);
    assert.equal(second.costUsd, 0.05);
    assert.deepEqual(calls[1].params.slice(4), [40, 12, 0.05]);
  });

  it('normalizeUsage fills cost from token counts', () => {
    const usage = normalizeUsage({ promptTokens: 1_000_000, completionTokens: 0 });
    assert.equal(usage.costUsd, DEFAULT_INPUT_USD_PER_MTTOK);
  });
});
