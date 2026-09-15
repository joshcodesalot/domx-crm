const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLooseProxyLine, parseProxyLines } = require('./proxyUrl');

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
