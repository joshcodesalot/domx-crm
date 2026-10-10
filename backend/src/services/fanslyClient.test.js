const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAccountMediaBody,
  buildFeedAccountMediaBody,
  buildFeedPostBody,
  wallsFromMe,
  pickPostsWall,
  buildAccountMediaBundleBody,
  buildDeleteMessageBody,
  broadcastGroupFlags,
  buildBroadcastGroupBody,
  buildBroadcastMessageBody,
  mapBroadcastMessages,
  buildListCommands,
  buildLockedTextBody,
  buildFanNicknameBody,
  lifetimeGrossMills,
  pickCustomUsername,
  clientCheck,
  classifyLoginBody,
  fanslyFailureError,
  fanslyPreviewLocksToIp,
  FanslyApiError,
  ackIdsForOpenChat,
  mapGroupChats,
  mapListRows,
  sumLeadingUnread,
  mapMessageThread,
  messagingGroupsQuery,
  MESSAGE_CONTENT_MEDIA,
  MESSAGE_CONTENT_BUNDLE,
  MESSAGE_CONTENT_STORY,
  notificationUnreadCount,
  isFanslyInitUrl,
  rewriteHlsPlaylist,
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

describe('fansly feed post body', () => {
  const mediaId = '951257184874815488';
  const accountMediaId = '963854195029463040';
  const wallId = '950608551804416000';

  it('posts free vault media with an empty whitelist', () => {
    assert.deepEqual(buildFeedAccountMediaBody({ mediaId, permissions: {} }), [
      {
        mediaId,
        previewId: null,
        permissionFlags: 0,
        price: 0,
        whitelist: [],
        permissions: { permissionFlags: [] },
        tags: [],
      },
    ]);
  });

  it('keeps purchase, follow, and tier flags without a fan whitelist', () => {
    const tierId = '941016206926692353';
    const body = buildFeedAccountMediaBody({
      mediaId,
      permissions: {
        requirePurchase: true,
        price: 5,
        requireFollow: true,
        requireSubscription: true,
        subscriptionTierId: tierId,
      },
    });
    assert.deepEqual(body[0].whitelist, []);
    assert.equal(body[0].permissionFlags, 0);
    assert.equal(body[0].permissions.permissionFlags[0].flags, 1 | 2 | 4);
    assert.equal(body[0].permissions.permissionFlags[0].price, 5000);
  });

  it('marks any subscription tier on the media row', () => {
    const body = buildFeedAccountMediaBody({
      mediaId,
      permissions: { requireSubscription: true },
    });
    assert.equal(body[0].permissionFlags, 8);
    assert.deepEqual(body[0].whitelist, []);
    assert.deepEqual(body[0].permissions.permissionFlags, []);
  });

  it('matches the captured wall post body', () => {
    assert.deepEqual(
      buildFeedPostBody({
        content: 'i know youll love this',
        accountMediaId,
        wallId,
      }),
      {
        content: 'i know youll love this',
        fypFlags: 0,
        inReplyTo: null,
        quotedPostId: null,
        attachments: [{ contentId: accountMediaId, contentType: 1, pos: 0 }],
        scheduledFor: 0,
        expiresAt: 0,
        postReplyPermissionFlags: [],
        pinned: 0,
        wallIds: [wallId],
        pinWallIds: [],
      }
    );
  });

  it('reads the Posts wall from the account profile', () => {
    const walls = wallsFromMe({
      account: {
        id: '948650325143744512',
        walls: [
          {
            id: '950608551804416000',
            accountId: '948650325143744512',
            pos: 0,
            name: 'Posts',
            description: '',
            private: 0,
            metadata: '',
            defaultWall: true,
            mainWall: true,
          },
        ],
      },
    });
    assert.equal(pickPostsWall(walls), '950608551804416000');
  });

  it('prefers the Posts wall and falls back to the first position', () => {
    assert.equal(
      pickPostsWall([
        { id: '2', name: 'Clips', pos: 1 },
        { id: '1', name: 'Posts', pos: 0 },
      ]),
      '1'
    );
    assert.equal(
      pickPostsWall([
        { id: '9', name: 'Clips', pos: 2 },
        { id: '3', name: 'Main', pos: 0 },
      ]),
      '3'
    );
    assert.throws(
      () => pickPostsWall([]),
      (err) => err instanceof FanslyApiError && err.status === 502
    );
  });
});

describe('fansly media bundle', () => {
  const fanId = '927528690898714626';
  const creatorId = '948650325143744512';
  const mediaIds = [
    '951262775047372800',
    '951257047284858881',
    '951256925947850752',
    '951257099587842048',
  ];
  const whitelist = [
    { accountId: fanId, permissionFlags: 0 },
    { accountId: creatorId, permissionFlags: 0 },
  ];

  it('matches the captured multi-media $10 purchase bundle', () => {
    const body = buildAccountMediaBundleBody({
      mediaIds,
      fanId,
      creatorId,
      permissions: {
        requirePurchase: true,
        price: 10,
        requireSubscription: true,
        subscriptionTierId: null,
        requireFollow: false,
      },
    });
    assert.equal(body.permissionFlags, 8);
    assert.equal(body.price, 0);
    assert.deepEqual(body.whitelist, whitelist);
    assert.deepEqual(body.permissions.permissionFlags, [
      {
        type: 0,
        flags: 1,
        price: 10000,
        metadata: '{"1":"{\\"price\\":10000}"}',
      },
    ]);
    assert.deepEqual(body.tags, []);
    assert.equal(body.accountMediaModels.length, 4);
    assert.deepEqual(
      body.accountMediaModels.map((row) => row.mediaId),
      mediaIds
    );
    for (const row of body.accountMediaModels) {
      assert.equal(row.previewId, null);
      assert.equal(row.permissionFlags, 8);
      assert.equal(row.price, 0);
      assert.deepEqual(row.whitelist, whitelist);
      assert.equal(row.permissions, undefined);
    }
  });

  it('rejects a bundle with one item', () => {
    assert.throws(
      () =>
        buildAccountMediaBundleBody({
          mediaIds: ['1'],
          fanId: '2',
          creatorId: '3',
          permissions: {},
        }),
      (err) => err instanceof FanslyApiError && err.status === 400
    );
  });
});

describe('fansly message media', () => {
  const poster = 'https://cdn3.fansly.com/acct/poster.jpeg?Policy=locked';
  const full = 'https://cdn3.fansly.com/acct/photo.jpeg?Signature=abc';
  const playlist = 'https://cdn3.fansly.com/new/acct/vid/vid.m3u8';

  it('joins a single account-media attachment as content type 1', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm1',
          content: 'photo',
          senderId: 'creator',
          createdAt: 10,
          attachments: [{ contentType: MESSAGE_CONTENT_MEDIA, contentId: 'am-photo', pos: 0 }],
        },
      ],
      accountMedia: [
        {
          id: 'am-photo',
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 5000 }] },
          media: {
            id: 'photo-1',
            type: 1,
            locations: [{ location: full }],
            variants: [{ type: 1, width: 240, locations: [{ location: poster }] }],
          },
        },
      ],
    });
    assert.equal(message.attachments[0].contentType, MESSAGE_CONTENT_MEDIA);
    assert.equal(message.media.length, 1);
    assert.equal(message.media[0].kind, 'image');
    assert.equal(message.media[0].mediaId, 'photo-1');
    assert.equal(message.media[0].previewUrl, poster);
    assert.equal(message.media[0].fullUrl, full);
    assert.equal(message.media[0].playlistUrl, null);
    assert.equal(message.media[0].price, 5);
  });

  it('expands a bundle attachment in accountMediaIds order', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm2',
          content: 'bundle',
          senderId: 'creator',
          createdAt: 11,
          attachments: [{ contentType: MESSAGE_CONTENT_BUNDLE, contentId: 'bundle-1', pos: 0 }],
        },
      ],
      accountMediaBundles: [
        {
          id: 'bundle-1',
          accountMediaIds: ['am-video', 'am-photo'],
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 10000 }] },
        },
      ],
      accountMedia: [
        {
          id: 'am-photo',
          media: {
            id: 'photo-1',
            type: 1,
            locations: [{ location: full }],
            variants: [{ type: 1, width: 240, locations: [{ location: poster }] }],
          },
        },
        {
          id: 'am-video',
          media: {
            id: 'video-1',
            type: 2,
            mimetype: 'video/mp4',
            locations: [{ location: 'https://cdn3.fansly.com/acct/video-1.mp4' }],
            variants: [
              { type: 1, width: 480, locations: [{ location: poster }] },
              { type: 302, mimetype: 'application/vnd.apple.mpegurl', locations: [{ location: playlist }] },
              { type: 303, locations: [{ location: 'https://cdn3.fansly.com/new/acct/vid/vid.mpd' }] },
            ],
          },
        },
      ],
    });
    assert.equal(message.attachments[0].contentType, MESSAGE_CONTENT_BUNDLE);
    assert.deepEqual(
      message.media.map((item) => item.mediaId),
      ['video-1', 'photo-1']
    );
    assert.equal(message.media[0].kind, 'video');
    assert.equal(message.media[0].playlistUrl, playlist);
    assert.equal(message.media[0].playlistLocked, false);
    assert.equal(message.media[0].fullUrl, null);
    assert.equal(message.media[0].previewUrl, poster);
    assert.equal(message.media[0].duration, null);
    assert.equal(message.media[0].price, 10);
    assert.equal(message.media[1].kind, 'image');
    assert.equal(message.media[1].price, 10);
  });

  it('marks an IP-locked playlist', () => {
    const policy = Buffer.from(
      JSON.stringify({
        Statement: [{ Condition: { IpAddress: { 'AWS:SourceIp': '203.0.113.10/32' } } }],
      })
    ).toString('base64');
    const lockedPlaylist = `https://cdn3.fansly.com/new/acct/vid/vid.m3u8?Policy=${encodeURIComponent(policy)}`;
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm3',
          content: 'locked video',
          senderId: 'creator',
          createdAt: 12,
          attachments: [{ contentType: MESSAGE_CONTENT_MEDIA, contentId: 'am-video', pos: 0 }],
        },
      ],
      accountMedia: [
        {
          id: 'am-video',
          media: {
            id: 'video-locked',
            type: 2,
            variants: [{ type: 302, locations: [{ location: lockedPlaylist }] }],
          },
        },
      ],
    });
    assert.equal(message.media[0].playlistUrl, lockedPlaylist);
    assert.equal(message.media[0].playlistLocked, true);
  });

  it('reads video length from metadata', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm4',
          content: 'timed',
          senderId: 'creator',
          createdAt: 13,
          attachments: [{ contentType: MESSAGE_CONTENT_MEDIA, contentId: 'am-video', pos: 0 }],
        },
      ],
      accountMedia: [
        {
          id: 'am-video',
          media: {
            id: 'video-timed',
            type: 2,
            metadata: '{"originalHeight":1920,"originalWidth":1080,"duration":9.25}',
            variants: [{ type: 1, locations: [{ location: poster }] }],
          },
        },
      ],
    });
    assert.equal(message.media[0].duration, 9.25);
  });
});

describe('fansly hls playlist rewrite', () => {
  it('rewrites relative playlists, segments, and URI attributes', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      'media-2/stream.m3u8',
      '#EXTINF:2.000000,',
      'segment-0.ts',
      '#EXT-X-MAP:URI="init.mp4"',
    ].join('\n');
    const rewritten = rewriteHlsPlaylist(
      playlist,
      'https://cdn3.fansly.com/new/acct/vid/vid.m3u8',
      (absolute) => `proxy:${absolute}`
    );
    assert.match(
      rewritten,
      /proxy:https:\/\/cdn3\.fansly\.com\/new\/acct\/vid\/media-2\/stream\.m3u8/
    );
    assert.match(rewritten, /proxy:https:\/\/cdn3\.fansly\.com\/new\/acct\/vid\/segment-0\.ts/);
    assert.match(
      rewritten,
      /URI="proxy:https:\/\/cdn3\.fansly\.com\/new\/acct\/vid\/init\.mp4"/
    );
    assert.doesNotMatch(rewritten, /video-1\.mp4/);
  });

  it('allows an HLS init segment and rejects other mp4 files', () => {
    assert.equal(
      isFanslyInitUrl('https://cdn3.fansly.com/new/acct/vid/init.mp4'),
      true
    );
    assert.equal(
      isFanslyInitUrl('https://cdn3.fansly.com/new/acct/vid/media-2/init.mp4'),
      true
    );
    assert.equal(isFanslyInitUrl('https://cdn3.fansly.com/acct/video-1.mp4'), false);
    assert.equal(isFanslyInitUrl('https://evil.example/init.mp4'), false);
  });
});

describe('fansly locked text', () => {
  it('matches the captured $1 story', () => {
    assert.deepEqual(
      buildLockedTextBody({
        content: 'test',
        permissions: {
          requirePurchase: true,
          price: 1,
          requireSubscription: false,
          requireFollow: false,
        },
      }),
      {
        title: '',
        description: '',
        content: 'test',
        permissions: {
          permissionFlags: [
            {
              type: 0,
              flags: 1,
              price: 1000,
              metadata: '{"1":"{\\"price\\":1000}"}',
            },
          ],
        },
      }
    );
  });

  it('rejects empty locked text', () => {
    assert.throws(
      () => buildLockedTextBody({ content: '  ', permissions: { requirePurchase: true, price: 1 } }),
      (err) => err instanceof FanslyApiError && err.status === 400
    );
  });
});

describe('fansly inbox groups', () => {
  it('passes sort, subscriber tier, and numeric list ids', () => {
    assert.deepEqual(
      messagingGroupsQuery({
        sortOrder: 2,
        flags: 4,
        subscriptionTierId: '950775164264538112',
        listIds: '123,abc,456',
        search: 'dc',
        limit: 20,
        offset: 20,
      }),
      {
        sortOrder: 2,
        flags: 4,
        subscriptionTierId: '950775164264538112',
        listIds: '123,456',
        search: 'dc',
        limit: 20,
        offset: 20,
      }
    );
  });

  it('keeps unread sort and drops unknown flags', () => {
    const query = messagingGroupsQuery({ sortOrder: 3, flags: 7, search: '' });
    assert.equal(query.sortOrder, 3);
    assert.equal(query.flags, 0);
    assert.equal(query.search, '');
  });

  it('picks the smallest non-blur avatar from aggregation accounts', () => {
    const small = 'https://cdn3.fansly.com/small.jpg?Expires=1&Signature=c';
    const [chat] = mapGroupChats({
      data: [
        {
          groupId: 'g1',
          partnerAccountId: '927528690898714626',
          partnerUsername: 'dc2cool',
          unreadCount: 1,
          lastMessageId: 'm1',
          lastUnreadMessageId: '962532559676268544',
          flags: 2,
        },
      ],
      aggregationData: {
        accounts: [
          {
            id: '927528690898714626',
            username: 'dc2cool',
            avatar: {
              variants: [
                {
                  type: 3,
                  width: 80,
                  locations: [{ location: 'https://cdn3.fansly.com/blur.jpg?Expires=1&Signature=a' }],
                },
                {
                  type: 1,
                  width: 720,
                  locations: [{ location: 'https://cdn3.fansly.com/large.jpg?Expires=1&Signature=b' }],
                },
                {
                  type: 1,
                  width: 240,
                  locations: [{ location: small }],
                },
              ],
            },
          },
        ],
      },
    });
    assert.equal(chat.partnerAccountId, '927528690898714626');
    assert.equal(chat.partnerAvatarUrl, small);
    assert.equal(chat.lastUnreadMessageId, '962532559676268544');
  });

  it('counts one unread chat instead of a full interaction page', () => {
    const interactionPage = Array.from({ length: 100 }, (_, index) => ({
      messageId: String(index),
      groupId: 'other',
      readAt: null,
      validMessage: true,
    }));
    const { total, done } = sumLeadingUnread([
      { groupId: 'open', unreadCount: 1 },
      { groupId: 'read', unreadCount: 0 },
    ]);
    assert.equal(interactionPage.length, 100);
    assert.equal(total, 1);
    assert.equal(done, true);
  });

  it('keeps summing while a full page is entirely unread', () => {
    const page = Array.from({ length: 20 }, (_, index) => ({
      groupId: String(index),
      unreadCount: 2,
    }));
    const { total, done } = sumLeadingUnread(page);
    assert.equal(total, 40);
    assert.equal(done, false);
  });

  it('acks unread interactions for the open chat and unread incoming messages', () => {
    const ids = ackIdsForOpenChat({
      groupId: '941499222019043328',
      providerUserId: 'creator',
      interactions: [
        {
          messageId: '962950114589028352',
          groupId: '941499222019043328',
          readAt: null,
          validMessage: true,
        },
        {
          messageId: 'already-read',
          groupId: '941499222019043328',
          readAt: 1,
          validMessage: true,
        },
        {
          messageId: 'other-chat',
          groupId: '999',
          readAt: null,
          validMessage: true,
        },
        {
          messageId: 'invalid',
          groupId: '941499222019043328',
          readAt: null,
          validMessage: false,
        },
      ],
      messages: [
        { id: '962950114589028352', senderId: 'fan', interactions: [] },
        { id: 'from-me', senderId: 'creator', interactions: [] },
        {
          id: 'seen',
          senderId: 'fan',
          interactions: [{ userId: 'creator', readAt: 5 }],
        },
        { id: 'missed', senderId: 'fan', interactions: [{ userId: 'creator', readAt: null }] },
      ],
    });
    assert.deepEqual(ids, ['962950114589028352', 'missed']);
  });

  it('acks a sent last-unread message and a null-group unread interaction in this chat', () => {
    const ids = ackIdsForOpenChat({
      groupId: '941499222019043328',
      providerUserId: 'creator',
      lastUnreadMessageId: '962000000000000001',
      interactions: [
        {
          messageId: 'orphan',
          groupId: null,
          readAt: null,
          validMessage: true,
        },
        {
          messageId: 'other-orphan',
          groupId: null,
          readAt: null,
          validMessage: true,
        },
        {
          messageId: 'deleted-orphan',
          groupId: null,
          readAt: null,
          deletedAt: 1,
          validMessage: true,
        },
      ],
      messages: [
        { id: 'orphan', groupId: '941499222019043328', senderId: 'creator', interactions: [] },
        { id: 'other-orphan', groupId: '999', senderId: 'fan', interactions: [] },
        { id: '962000000000000001', groupId: '941499222019043328', senderId: 'creator', interactions: [] },
        { id: 'my-other-sent', groupId: '941499222019043328', senderId: 'creator', interactions: [] },
        {
          id: 'fresh',
          groupId: '941499222019043328',
          senderId: 'fan',
          interactions: [{ userId: 'creator', readAt: 0 }],
        },
      ],
    });
    assert.deepEqual(ids, ['orphan', '962000000000000001', 'fresh']);
  });

  it('does not ack a last-unread message from another chat', () => {
    const ids = ackIdsForOpenChat({
      groupId: '941499222019043328',
      providerUserId: 'creator',
      lastUnreadMessageId: '962000000000000002',
      interactions: [],
      messages: [{ id: '962000000000000002', groupId: '999', senderId: 'creator', interactions: [] }],
    });
    assert.deepEqual(ids, []);
  });

  it('leaves the avatar empty when the account has none', () => {
    const [chat] = mapGroupChats({
      data: [{ groupId: 'g2', partnerAccountId: '1', partnerUsername: 'fan' }],
      aggregationData: { accounts: [{ id: '1', username: 'fan' }] },
    });
    assert.equal(chat.partnerAvatarUrl, null);
    assert.equal(chat.lastUnreadMessageId, null);
  });
});

describe('fansly locked text thread', () => {
  it('joins a 32001 story onto the message', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm-lock',
          content: '',
          senderId: 'creator',
          createdAt: 12,
          attachments: [
            { contentType: MESSAGE_CONTENT_STORY, contentId: '963202346916007936', pos: 0 },
          ],
        },
      ],
      stories: [
        {
          id: '963202346916007936',
          content: 'test',
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 1000 }] },
        },
      ],
    });
    assert.equal(message.attachments[0].contentType, MESSAGE_CONTENT_STORY);
    assert.deepEqual(message.lockedText, [
      {
        id: '963202346916007936',
        content: 'test',
        price: 1,
        purchased: false,
        access: false,
      },
    ]);
    assert.deepEqual(message.media, []);
  });

  it('keeps creator access from counting as a locked-text purchase', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm-lock-owned',
          content: '',
          senderId: 'creator',
          createdAt: 12,
          attachments: [
            { contentType: MESSAGE_CONTENT_STORY, contentId: '963202346916007936', pos: 0 },
          ],
        },
      ],
      stories: [
        {
          id: '963202346916007936',
          content: 'secret',
          purchased: true,
          access: true,
          whitelisted: true,
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 1000 }] },
        },
      ],
      storyOrders: [],
    });
    assert.equal(message.lockedText[0].price, 1);
    assert.equal(message.lockedText[0].purchased, false);
    assert.equal(message.lockedText[0].access, true);
  });

  it('marks locked text purchased when a story order matches', () => {
    const [message] = mapMessageThread({
      messages: [
        {
          id: 'm-lock-sold',
          content: '',
          senderId: 'creator',
          createdAt: 12,
          attachments: [
            { contentType: MESSAGE_CONTENT_STORY, contentId: '963202346916007936', pos: 0 },
          ],
        },
      ],
      stories: [
        {
          id: '963202346916007936',
          content: 'secret',
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 1000 }] },
        },
      ],
      storyOrders: [{ accountMediaId: '963202346916007936' }],
    });
    assert.equal(message.lockedText[0].purchased, true);
  });
});

describe('fansly ppv purchase orders', () => {
  const bundleId = '964094309802459137';
  const mediaId = '964094309664051200';

  function unsoldBundleThread(orders) {
    return mapMessageThread({
      messages: [
        {
          id: '964094311182381056',
          content: '',
          senderId: '948650325143744512',
          createdAt: 1791352355,
          attachments: [{ contentType: MESSAGE_CONTENT_BUNDLE, contentId: bundleId, pos: 0 }],
        },
      ],
      accountMedia: [
        {
          id: mediaId,
          purchased: true,
          access: true,
          whitelisted: true,
          accountPermissionFlags: 255,
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 0 }] },
          media: {
            id: '951258463059587078',
            type: 1,
            locations: [{ location: 'https://cdn3.fansly.com/photo.jpeg' }],
          },
        },
      ],
      accountMediaBundles: [
        {
          id: bundleId,
          accountMediaIds: [mediaId],
          purchased: true,
          access: true,
          whitelisted: true,
          accountPermissionFlags: 255,
          permissions: { permissionFlags: [{ type: 0, flags: 1, price: 10000 }] },
        },
      ],
      accountMediaOrders: orders,
      storyOrders: [],
    });
  }

  it('does not mark a creator-owned $10 bundle sold when nobody has bought it', () => {
    const [message] = unsoldBundleThread([]);
    assert.equal(message.media.length, 1);
    assert.equal(message.media[0].price, 10);
    assert.equal(message.media[0].purchased, false);
    assert.equal(message.media[0].access, true);
  });

  it('marks the bundle sold when an order references the bundle id', () => {
    const [message] = unsoldBundleThread([{ accountMediaId: bundleId }]);
    assert.equal(message.media[0].price, 10);
    assert.equal(message.media[0].purchased, true);
  });
});

describe('fansly fan lists', () => {
  const fanId = '927528690898714626';
  const listId = '951713542833184769';

  it('matches the captured add command', () => {
    assert.deepEqual(buildListCommands({ action: 'add', fanId, listId }), {
      listCommands: [{ type: 1, listItem: { id: fanId, listId } }],
    });
  });

  it('matches the captured remove command', () => {
    assert.deepEqual(buildListCommands({ action: 'remove', fanId, listId }), {
      listCommands: [{ type: 2, listId, itemIds: [fanId] }],
    });
  });

  it('maps the captured mass-message list payload', () => {
    assert.deepEqual(
      mapListRows([
        {
          id: '951713542833184769',
          accountId: '948650325143744512',
          pos: null,
          type: 1,
          label: 'ACTIVELY CHATTING',
          itemCount: 2,
        },
        {
          id: '960343602666434560',
          accountId: '948650325143744512',
          pos: null,
          type: 1,
          label: 'No mm at all cost',
          itemCount: 1,
        },
        {
          id: '960930326035582976',
          accountId: '948650325143744512',
          pos: null,
          type: 1,
          label: 'willing to spend on wednesday',
          itemCount: 1,
        },
      ]),
      [
        { id: '951713542833184769', label: 'ACTIVELY CHATTING' },
        { id: '960343602666434560', label: 'No mm at all cost' },
        { id: '960930326035582976', label: 'willing to spend on wednesday' },
      ]
    );
  });

  it('maps account lists to ids and labels', () => {
    assert.deepEqual(
      mapListRows([
        {
          id: '951713542833184769',
          accountId: '948650325143744512',
          type: 1,
          label: 'ACTIVELY CHATTING',
          itemCount: 2,
        },
        { id: 'not-a-list', label: 'Skip' },
      ]),
      [{ id: '951713542833184769', label: 'ACTIVELY CHATTING' }]
    );
  });

  it('rejects a list command without ids', () => {
    assert.throws(
      () => buildListCommands({ action: 'add', fanId: '', listId }),
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

describe('fansly broadcast', () => {
  const creatorId = '948650325143744512';
  const excludeListId = '960343602666434560';
  const includeListId = '951713542833184769';
  const mediaId = '963851255938039808';
  const accountMediaId = '963865913784807424';
  const groupId = '960717172055744512';

  it('defaults the audience to subscribers and exclude creators', () => {
    assert.equal(broadcastGroupFlags({}), 4 | 8 | 32);
    assert.equal(
      broadcastGroupFlags({
        followers: true,
        subscribers: true,
        expiredSubscribers: true,
        excludeCreators: true,
      }),
      62
    );
  });

  it('matches the captured exclude-list broadcast group', () => {
    assert.deepEqual(
      buildBroadcastGroupBody({
        creatorId,
        groupFlags: 62,
        excludeListIds: [excludeListId],
      }),
      {
        users: [{ userId: creatorId, permissionFlags: 65535 }],
        recipients: [{ recipientId: excludeListId, type: 30001 }],
        lastMessage: null,
        userSettings: null,
        type: 3,
        groupFlags: 62,
        groupFlagsMetadata: '',
      }
    );
  });

  it('includes lists, excluded users, and a subscription tier', () => {
    const tierId = '941016206926692353';
    const excludedUser = '927528690898714626';
    const body = buildBroadcastGroupBody({
      creatorId,
      groupFlags: 4 | 8 | 32,
      includeListIds: [includeListId],
      excludeUserIds: [excludedUser, creatorId],
      subscriptionTierId: tierId,
    });
    assert.deepEqual(body.users, [
      { userId: creatorId, permissionFlags: 65535 },
      { userId: excludedUser, permissionFlags: 0 },
    ]);
    assert.deepEqual(body.recipients, [{ recipientId: includeListId, type: 30000 }]);
    assert.equal(
      body.groupFlagsMetadata,
      JSON.stringify({ 4: JSON.stringify({ subscriptionTierId: tierId }) })
    );
  });

  it('rejects an audience with no recipients', () => {
    assert.throws(
      () =>
        buildBroadcastGroupBody({
          creatorId,
          groupFlags: 32,
        }),
      (err) => err instanceof FanslyApiError && err.status === 400
    );
  });

  it('allows a list-only audience', () => {
    const body = buildBroadcastGroupBody({
      creatorId,
      groupFlags: 32,
      includeListIds: [includeListId],
    });
    assert.equal(body.groupFlags, 32);
    assert.equal(body.recipients[0].type, 30000);
  });

  it('sends unlocked media with an empty whitelist', () => {
    assert.deepEqual(buildAccountMediaBody({ mediaId, permissions: {} }), [
      {
        mediaId,
        previewId: null,
        permissionFlags: 0,
        price: 0,
        whitelist: [],
        permissions: { permissionFlags: [] },
        tags: [],
      },
    ]);
    const bundle = buildAccountMediaBundleBody({
      mediaIds: [mediaId, '951255491411996672'],
      permissions: {},
    });
    assert.deepEqual(bundle.whitelist, []);
    assert.deepEqual(bundle.permissions.permissionFlags, []);
    assert.equal(bundle.permissionFlags, 0);
  });

  it('matches a text-only broadcast and a media broadcast', () => {
    assert.deepEqual(
      buildBroadcastMessageBody({
        groupId,
        content: 'what are you doing right now?',
        createdAt: 1791297901.15,
      }),
      {
        type: 1,
        attachments: [],
        likes: [],
        content: 'what are you doing right now?',
        groupId,
        scheduledFor: 0,
        inReplyTo: null,
        createdAt: 1791297901.15,
      }
    );
    assert.deepEqual(
      buildBroadcastMessageBody({
        groupId,
        content: 'what are you doing right now?',
        attachments: [{ contentId: accountMediaId, contentType: 1 }],
        createdAt: 1791297901.15,
      }).attachments,
      [{ messageId: null, pos: 0, contentId: accountMediaId, contentType: 1 }]
    );
  });

  it('rejects an empty broadcast', () => {
    assert.throws(
      () => buildBroadcastMessageBody({ groupId, content: '   ' }),
      (err) => err instanceof FanslyApiError && err.status === 400
    );
  });

  it('maps broadcast stats and attached media', () => {
    const [message] = mapBroadcastMessages({
      messages: [
        {
          id: '963619324830949376',
          type: 3,
          content: 'Say please',
          createdAt: 1791239109,
          attachments: [
            { messageId: '963619324830949376', contentType: 1, contentId: accountMediaId, pos: 0 },
          ],
          stats: { total: 50, delivered: 57, read: 1 },
        },
      ],
      accountMedia: [
        {
          id: accountMediaId,
          mediaId,
          permissions: { permissionFlags: [] },
          media: {
            id: mediaId,
            type: 1,
            mimetype: 'image/jpeg',
            locations: [{ location: 'https://cdn3.fansly.com/a.jpeg' }],
          },
        },
      ],
    });
    assert.equal(message.id, '963619324830949376');
    assert.equal(message.content, 'Say please');
    assert.equal(message.createdAt, 1791239109);
    assert.equal(message.deletedAt, null);
    assert.deepEqual(message.stats, { total: 50, delivered: 57, read: 1 });
    assert.equal(message.media[0].mediaId, mediaId);
    assert.equal(message.media[0].kind, 'image');
  });
});
