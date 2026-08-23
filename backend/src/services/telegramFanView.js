const USERNAME_VISIBLE_ROLES = new Set([
  'owner',
  'manager',
  'backend',
  'team_leader',
]);

const OPEN_BY_USERNAME_ROLES = new Set(['owner', 'manager']);

const SERVICE_CHAT_ROLES = new Set(['owner', 'manager', 'backend']);

function canViewFanUsername(user) {
  return USERNAME_VISIBLE_ROLES.has(user?.role);
}

function canOpenChatByUsername(user) {
  return OPEN_BY_USERNAME_ROLES.has(user?.role);
}

function canSeeTelegramServiceChats(user) {
  return SERVICE_CHAT_ROLES.has(user?.role);
}

function redactFan(fan, user) {
  if (!fan || typeof fan !== 'object') return fan;
  const kind = fan.kind === 'group' ? 'group' : 'dm';
  const avatarUrl = fan.avatarUrl || null;
  if (canViewFanUsername(user)) {
    return {
      telegramUserId: fan.telegramUserId,
      kind,
      displayName: fan.displayName || (kind === 'group' ? 'Group' : 'Fan'),
      nickname: fan.nickname || '',
      notes: fan.notes || '',
      username: fan.username || null,
      hasUsername: Boolean(fan.username),
      avatarUrl,
    };
  }
  return {
    telegramUserId: fan.telegramUserId,
    kind,
    displayName: fan.displayName || (kind === 'group' ? 'Group' : 'Fan'),
    nickname: fan.nickname || '',
    notes: fan.notes || '',
    hasUsername: Boolean(fan.username),
    avatarUrl,
  };
}

function redactMessage(msg, user) {
  if (!msg || typeof msg !== 'object') return msg;
  if (canViewFanUsername(user)) return msg;
  const { senderUsername, ...rest } = msg;
  void senderUsername;
  return rest;
}

function redactDialog(dialog, user) {
  if (!dialog) return dialog;
  const { username, user: nestedUser, lastMessage, ...rest } = dialog;
  void username;
  void nestedUser;
  return {
    ...rest,
    lastMessage: lastMessage ? redactMessage(lastMessage, user) : lastMessage,
    fan: redactFan(
      {
        telegramUserId: dialog.peerId,
        kind: dialog.kind,
        displayName: dialog.displayName,
        nickname: dialog.nickname,
        notes: dialog.notes,
        username: dialog.username,
        avatarUrl: dialog.avatarUrl,
      },
      user
    ),
  };
}

module.exports = {
  canViewFanUsername,
  canOpenChatByUsername,
  canSeeTelegramServiceChats,
  redactFan,
  redactDialog,
  redactMessage,
};
