const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAccountMediaBody,
  buildDeleteMessageBody,
  buildFanNicknameBody,
  lifetimeGrossMills,
  pickCustomUsername,
  clientCheck,
  classifyLoginBody,
  fanslyFailureError,
  fanslyPreviewLocksToIp,
  FanslyApiError,
  notificationUnreadCount,
  sanitizeNotificationType,
  WrongPasswordError,
} = require('./fanslyClient');

describe('fansly client check', () => {
  const deviceId = '881829141681287168';

  it('matches the captured login request', () => {
    assert.equal(clientCheck('/api/v1/login', deviceId), '1c8e3faa8dec20');
  });

  it('matches the captured account and unread requests', () => {
    assert.equal(clientCheck('/api/v1/account/me', deviceId), '1d4d5ea10eb692');
    assert.equal(clientCheck('/api/v1/message/unread', deviceId), '1768606ea849fb');
  });
});

describe('fansly login body', () => {
  it('classifies a 2FA challenge', () => {
    const outcome = classifyLoginBody({
      twofa: {
        accountId: '879702847782936576',
        secretId: '899246440939806720',
        type: 0,
        id: '962876063040430080',
        token: 'challenge-token',
      },
    });
    assert.equal(outcome.kind, 'twofa');
    assert.equal(outcome.twofaToken, 'challenge-token');
    assert.equal(outcome.twofaType, 0);
    assert.equal(outcome.email, null);
  });

  it('classifies an email verification challenge', () => {
    const outcome = classifyLoginBody({
      twofa: {
        id: '963180762171977728',
        token: 'email-challenge-token',
        email: 'c************p@g****.com',
        type: 2,
      },
    });
    assert.equal(outcome.kind, 'twofa');
    assert.equal(outcome.twofaToken, 'email-challenge-token');
    assert.equal(outcome.twofaType, 2);
    assert.equal(outcome.email, 'c************p@g****.com');
  });

  it('classifies a nested session from password login', () => {
    const outcome = classifyLoginBody({
      session: {
        accountId: '938599743880187904',
        deviceId: null,
        status: 2,
        id: '962506073695080687',
        token: 'session-token',
        checkToken: null,
      },
    });
    assert.equal(outcome.kind, 'session');
    assert.equal(outcome.session.id, '962506073695080687');
    assert.equal(outcome.session.token, 'session-token');
  });

  it('classifies a top-level session from twofa verify', () => {
    const outcome = classifyLoginBody({
      accountId: '879702847782936576',
      deviceId: null,
      ip: '127.0.0.1',
      status: 2,
      metadata: null,
      id: '962876075245842432',
      token: 'session-token',
      checkToken: null,
    });
    assert.equal(outcome.kind, 'session');
    assert.equal(outcome.session.id, '962876075245842432');
    assert.equal(outcome.session.accountId, '879702847782936576');
  });

  it('does not treat a challenge as a session', () => {
    const outcome = classifyLoginBody({ twofa: { token: '' } });
    assert.equal(outcome.kind, 'missing');
  });
});

describe('fansly notification unread count', () => {
  it('sums per-type totals from the unack payload', () => {
    assert.equal(
      notificationUnreadCount([
        { type: 2002, total: 4 },
        { type: 5003, total: 2 },
      ]),
      6
    );
  });

  it('treats an empty unack list as zero', () => {
    assert.equal(notificationUnreadCount([]), 0);
  });

  it('reads a total field when the payload is not a type list', () => {
    assert.equal(notificationUnreadCount({ total: 3 }), 3);
  });

  it('counts a bare notification array', () => {
    assert.equal(notificationUnreadCount([{ id: '1' }, { id: '2' }]), 2);
  });
});

describe('fansly notification type filter', () => {
  it('keeps known codes and drops anything else', () => {
    assert.equal(sanitizeNotificationType('2007,2008,7001'), '2007,2008,7001');
    assert.equal(sanitizeNotificationType('7001,9999,2002'), '7001,2002');
    assert.equal(sanitizeNotificationType(''), '');
    assert.equal(sanitizeNotificationType('nope'), '');
  });
});

describe('fansly twofa errors', () => {
  it('maps a bad code to invalid authentication code', () => {
    const err = fanslyFailureError(
      { success: false, error: { code: 3, details: 'error verifying session' } },
      400,
      '/login/twofa'
    );
    assert.equal(err.message, 'Invalid authentication code');
    assert.equal(err.status, 400);
    assert.equal(err instanceof WrongPasswordError, false);
  });

  it('prefers error.details for other object errors', () => {
    const err = fanslyFailureError(
      { success: false, error: { code: 1, details: 'rate limited' } },
      429,
      '/login'
    );
    assert.equal(err.message, 'rate limited');
    assert.equal(err.status, 429);
  });
});

describe('fansly locked media body', () => {
  const fanId = '817219372694122497';
  const creatorId = '938599743880187904';
  const mediaId = '940926397164044288';

  it('matches the captured $10 purchase plus any-tier subscription', () => {
    assert.deepEqual(
      buildAccountMediaBody({
        mediaId,
        fanId,
        creatorId,
        permissions: {
          requirePurchase: true,
          price: 10,
          requireSubscription: true,
          subscriptionTierId: null,
          requireFollow: false,
        },
      }),
      [
        {
          mediaId,
          previewId: null,
          permissionFlags: 8,
          price: 0,
          whitelist: [
            { accountId: fanId, permissionFlags: 0 },
            { accountId: creatorId, permissionFlags: 0 },
          ],
          permissions: {
            permissionFlags: [
              {
                type: 0,
                flags: 1,
                price: 10000,
                metadata: '{"1":"{\\"price\\":10000}"}',
              },
            ],
          },
          tags: [],
        },
      ]
    );
  });

  it('sets the follow bit and leaves metadata empty', () => {
    const body = buildAccountMediaBody({
      mediaId: '1',
      fanId: '2',
      creatorId: '3',
      permissions: { requireFollow: true },
    });
    assert.equal(body[0].permissionFlags, 0);
    assert.deepEqual(body[0].permissions.permissionFlags, [
      { type: 0, flags: 2, metadata: '' },
    ]);
  });

  it('sets a named tier without the any-tier flag', () => {
    const tierId = '941016206926692353';
    const body = buildAccountMediaBody({
      mediaId: '1',
      fanId: '2',
      creatorId: '3',
      permissions: { requireSubscription: true, subscriptionTierId: tierId },
    });
    assert.equal(body[0].permissionFlags, 0);
    assert.equal(body[0].permissions.permissionFlags[0].flags, 4);
    assert.equal(
      body[0].permissions.permissionFlags[0].metadata,
      JSON.stringify({ 4: JSON.stringify({ subscriptionTierId: tierId }) })
    );
  });

  it('sends unlocked media with an empty permission list', () => {
    const body = buildAccountMediaBody({
      mediaId: '1',
      fanId: '2',
      creatorId: '3',
      permissions: {},
    });
    assert.equal(body[0].permissionFlags, 0);
    assert.deepEqual(body[0].permissions.permissionFlags, []);
  });

  it('rejects a purchase without a price', () => {
    assert.throws(
      () =>
        buildAccountMediaBody({
          mediaId: '1',
          fanId: '2',
          creatorId: '3',
          permissions: { requirePurchase: true, price: 0 },
        }),
      (err) => err instanceof FanslyApiError && err.status === 400
    );
  });
});

describe('fansly fan nickname', () => {
  it('matches the captured custom username edit', () => {
    assert.deepEqual(
      buildFanNicknameBody({
        fanId: '904224443591585792',
        nickname: 'Big Jay NYC/TW',
        noteId: '945857635440156672',
      }),
      {
        id: '945857635440156672',
        contentType: 12002,
        contentId: '904224443591585792',
        title: 'Custom Username',
        note: 'Big Jay NYC/TW',
      }
    );
  });

  it('omits the note id when the fan has no custom username yet', () => {
    const body = buildFanNicknameBody({
      fanId: '904224443591585792',
      nickname: 'Jay',
    });
    assert.equal(body.id, undefined);
    assert.equal(body.note, 'Jay');
    assert.equal(body.title, 'Custom Username');
  });

  it('reads only the custom username note', () => {
    assert.deepEqual(
      pickCustomUsername([
        { id: '1', title: 'Other', note: 'ignore' },
        { id: '945857635440156672', title: 'Custom Username', note: 'Big Jay NYC' },
      ]),
      { noteId: '945857635440156672', nickname: 'Big Jay NYC' }
    );
    assert.deepEqual(pickCustomUsername([]), { noteId: null, nickname: '' });
  });
});

describe('fansly fan lifetime value', () => {
  it('sums gross mills across product types', () => {
    assert.equal(
      lifetimeGrossMills({
        byProductType: [
          { productType: 2116, grossMills: 5000, netMills: 4000 },
          { productType: 2110, grossMills: 5000, netMills: 4000 },
        ],
      }),
      10000
    );
    assert.equal(lifetimeGrossMills({}), 0);
  });
});

function cloudFrontPolicy(statement) {
  return Buffer.from(JSON.stringify({ Statement: [statement] })).toString('base64');
}

describe('fansly preview ip lock', () => {
  it('detects a CloudFront policy locked to a source IP', () => {
    const policy = cloudFrontPolicy({
      Condition: { IpAddress: { 'AWS:SourceIp': '203.0.113.0/24' } },
    });
    const url = `https://cdn3.fansly.com/1/2.jpeg?Policy=${encodeURIComponent(policy)}&Signature=abc`;
    assert.equal(fanslyPreviewLocksToIp(url), true);
  });

  it('leaves an expiry-only link unlocked', () => {
    const url = 'https://cdn3.fansly.com/1/2.jpeg?Expires=1791769164&Key-Pair-Id=K&Signature=abc';
    assert.equal(fanslyPreviewLocksToIp(url), false);
  });

  it('treats a broken policy as unlocked', () => {
    const url = 'https://cdn3.fansly.com/1/2.jpeg?Policy=%%%&Signature=abc';
    assert.equal(fanslyPreviewLocksToIp(url), false);
  });
});

describe('fansly delete message body', () => {
  it('matches the captured delete request', () => {
    assert.deepEqual(buildDeleteMessageBody('963147179000623104'), {
      messageId: '963147179000623104',
    });
  });

  it('rejects a missing message id', () => {
    assert.throws(
      () => buildDeleteMessageBody(''),
      (err) => err instanceof FanslyApiError && /Message id/.test(err.message)
    );
  });
});
