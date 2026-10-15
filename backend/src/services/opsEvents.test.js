const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MESSAGE_MAX,
  shouldRecordRequest,
  requestKind,
  sanitizeMessage,
  errorDetails,
  opsProcess,
} = require('./opsEvents');
const { requireOwnerOrManager } = require('../middleware/authorize');
describe('opsProcess', () => {
  const previous = process.env.PROCESS_ROLE;

  function restore() {
    if (previous === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = previous;
  }

  it('uses api unless the role is worker', () => {
    try {
      delete process.env.PROCESS_ROLE;
      assert.equal(opsProcess(), 'api');
      process.env.PROCESS_ROLE = 'all';
      assert.equal(opsProcess(), 'api');
      process.env.PROCESS_ROLE = 'api';
      assert.equal(opsProcess(), 'api');
      process.env.PROCESS_ROLE = 'worker';
      assert.equal(opsProcess(), 'worker');
    } finally {
      restore();
    }
  });
});

describe('ops request gate', () => {
  it('stores status 500 and requests that take at least 2000ms', () => {
    assert.equal(shouldRecordRequest(500, 10), true);
    assert.equal(shouldRecordRequest(503, 5), true);
    assert.equal(shouldRecordRequest(200, 2000), true);
    assert.equal(shouldRecordRequest(200, 1999), false);
    assert.equal(shouldRecordRequest(404, 50), false);
    assert.equal(requestKind(500), 'error');
    assert.equal(requestKind(200), 'slow_request');
  });
});

describe('ops error sanitizing', () => {
  it('truncates the message to 500 characters', () => {
    assert.equal(sanitizeMessage('a'.repeat(800)).length, MESSAGE_MAX);
  });

  it('redacts proxy URLs, bearer tokens, and secret env values in the message', () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'super-secret-value';
    try {
      const message = sanitizeMessage(
        'connect failed via http://user:pass@proxy.example:8080 using Bearer abcdefghijklmnop and super-secret-value'
      );
      assert.equal(message.includes('pass@'), false);
      assert.equal(message.includes('abcdefghijklmnop'), false);
      assert.equal(message.includes('super-secret-value'), false);
      assert.match(message, /\[redacted\]/);
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });

  it('omits stacks that contain a proxy URL, a JWT, or a secret env value', () => {
    const proxy = errorDetails(Object.assign(new Error('proxy failed'), {
      stack: 'Error: proxy failed\n    at http://user:pass@host:1/path',
    }));
    assert.equal(proxy.stackOmitted, true);
    assert.equal(proxy.stack, undefined);

    const jwt = errorDetails(Object.assign(new Error('bad token'), {
      stack: 'Error: bad token\n    at eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signature',
    }));
    assert.equal(jwt.stackOmitted, true);
    assert.equal(jwt.stack, undefined);

    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'super-secret-value';
    try {
      const leaked = errorDetails(Object.assign(new Error('nope'), {
        stack: 'Error: nope\n    at secret super-secret-value here',
      }));
      assert.equal(leaked.stackOmitted, true);
      assert.equal(leaked.stack, undefined);
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });

  it('keeps a normal stack and a stack that only mentions a non-secret env value', () => {
    const err = new Error('plain failure');
    const details = errorDetails(err);
    assert.equal(details.name, 'Error');
    assert.match(details.stack, /plain failure/);
    assert.equal(details.stackOmitted, undefined);

    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\someone';
    const withPath = errorDetails(Object.assign(new Error('plain'), {
      stack: `Error: plain\n    at file (${home}\\app.js:1:1)`,
    }));
    assert.equal(withPath.stackOmitted, undefined);
    assert.match(withPath.stack, /plain/);
  });
});

describe('requireOwnerOrManager', () => {
  function run(role) {
    return new Promise((resolve) => {
      const req = { user: role ? { role } : undefined };
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, body, next: false });
        },
      };
      requireOwnerOrManager(req, res, () => resolve({ status: 200, next: true }));
    });
  }

  it('allows the owner and the manager', async () => {
    assert.equal((await run('owner')).next, true);
    assert.equal((await run('manager')).next, true);
    for (const role of ['chatter', 'backend', 'team_leader', 'marketing', null]) {
      const result = await run(role);
      assert.equal(result.next, false);
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'Owner or manager access required' });
    }
  });
});
