const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadSelector() {
  const href = pathToFileURL(
    path.join(__dirname, '../../../frontend/src/lib/historyTranslateWindow.mjs')
  ).href;
  return import(href);
}

describe('history auto-translate window', () => {
  it('keeps only the newest 20 eligible messages', async () => {
    const { HISTORY_AUTO_TRANSLATE_LIMIT, selectAutoHistoryTranslations } = await loadSelector();
    assert.equal(HISTORY_AUTO_TRANSLATE_LIMIT, 20);
    const items = Array.from({ length: 25 }, (_, index) => ({
      key: `m-${index}`,
      text: `text ${index}`,
    }));
    const selected = selectAutoHistoryTranslations(items);
    assert.equal(selected.length, 20);
    assert.equal(selected[0].key, 'm-0');
    assert.equal(selected[19].key, 'm-19');
  });

  it('does not pull older messages in to replace ones already translated', async () => {
    const { selectAutoHistoryTranslations } = await loadSelector();
    const items = Array.from({ length: 25 }, (_, index) => ({
      key: `m-${index}`,
      text: `text ${index}`,
    }));
    const selected = selectAutoHistoryTranslations(items, (key) => key === 'm-0' || key === 'm-3');
    assert.equal(selected.length, 18);
    assert.equal(selected.some((item) => item.key === 'm-0'), false);
    assert.equal(selected.some((item) => item.key === 'm-20'), false);
    assert.equal(selected[0].key, 'm-1');
  });

  it('returns nothing when the limit is zero', async () => {
    const { selectAutoHistoryTranslations } = await loadSelector();
    const selected = selectAutoHistoryTranslations([{ key: 'm-0', text: 'hallo' }], undefined, 0);
    assert.deepEqual(selected, []);
  });
});
