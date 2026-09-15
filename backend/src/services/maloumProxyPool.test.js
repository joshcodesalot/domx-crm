const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseLooseProxyLine, parseProxyLines } = require('./proxyUrl');
const {
  selectKeepOrFree,
  selectRotateTarget,
  resetPoolRotateDebounceForTests,
} = require('./maloumProxyPool');

describe('parseLooseProxyLine', () => {
  it('parses Decodo host:port:user:pass', () => {
    const parsed = parseLooseProxyLine(
      'isp.decodo.com:10002:sphi0gkvzp:~lr70ekI2Mmx8dCLud'
    );
    assert.equal(parsed.hostPort, 'isp.decodo.com:10002');
    assert.equal(
      parsed.proxyUrl,
      'http://sphi0gkvzp:~lr70ekI2Mmx8dCLud@isp.decodo.com:10002'
    );
  });

  it('parses user:pass@host:port and skips blanks/dupes', () => {
    const items = parseProxyLines(
      [
        '',
        '# comment',
        'sphi0gkvzp:secret@isp.decodo.com:10005',
        'isp.decodo.com:10009:sphi0gkvzp:secret',
        'isp.decodo.com:10005:sphi0gkvzp:other',
      ].join('\n')
    );
    assert.deepEqual(
      items.map((item) => item.hostPort),
      ['isp.decodo.com:10005', 'isp.decodo.com:10009']
    );
  });
});

describe('pool assign and rotate', () => {
  beforeEach(() => {
    resetPoolRotateDebounceForTests();
  });

  it('sticky assign does not give two creators the same row', () => {
    const now = Date.now();
    const rows = [
      {
        id: 'p1',
        proxyUrl: 'http://a@isp.example:1',
        hostPort: 'isp.example:1',
        bannedUntil: null,
        assignedCreatorId: null,
      },
      {
        id: 'p2',
        proxyUrl: 'http://b@isp.example:2',
        hostPort: 'isp.example:2',
        bannedUntil: null,
        assignedCreatorId: null,
      },
    ];
    const first = selectKeepOrFree(rows, 'c1', now);
    assert.equal(first.action, 'assign');
    first.row.assignedCreatorId = 'c1';
    const second = selectKeepOrFree(rows, 'c2', now);
    assert.equal(second.action, 'assign');
    assert.notEqual(second.row.id, first.row.id);
  });

  it('ban + rotate picks a different free row', () => {
    const now = Date.now();
    const rows = [
      {
        id: 'p1',
        proxyUrl: 'http://a@isp.example:1',
        hostPort: 'isp.example:1',
        bannedUntil: null,
        assignedCreatorId: 'c1',
      },
      {
        id: 'p2',
        proxyUrl: 'http://b@isp.example:2',
        hostPort: 'isp.example:2',
        bannedUntil: null,
        assignedCreatorId: null,
      },
    ];
    const { current, next } = selectRotateTarget(
      rows,
      'c1',
      'isp.example:1',
      now
    );
    assert.equal(current.id, 'p1');
    assert.equal(next.id, 'p2');
  });
});
