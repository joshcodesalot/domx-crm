const USERNAME_VISIBLE_ROLES = new Set([
  'owner',
  'manager',
  'backend',
  'team_leader',
]);

const OPEN_BY_USERNAME_ROLES = new Set(['owner', 'manager']);

function canViewFanUsername(user) {
  return USERNAME_VISIBLE_ROLES.has(user?.role);
}

function canOpenChatByUsername(user) {
  return OPEN_BY_USERNAME_ROLES.has(user?.role);
}

function redactFan(fan, user) {
  if (!fan || typeof fan !== 'object') return fan;
  if (canViewFanUsername(user)) {
    return {
      telegramUserId: fan.telegramUserId,
      displayName: fan.displayName || 'Fan',
      nickname: fan.nickname || '',
      notes: fan.notes || '',
      username: fan.username || null,
      hasUsername: Boolean(fan.username),
    };
  }
  return {
    telegramUserId: fan.telegramUserId,
    displayName: fan.displayName || 'Fan',
    nickname: fan.nickname || '',
    notes: fan.notes || '',
    hasUsername: Boolean(fan.username),
  };
}

function redactDialog(dialog, user) {
  if (!dialog) return dialog;
  const { username, user: nestedUser, ...rest } = dialog;
  void username;
  void nestedUser;
  return {
    ...rest,
    fan: redactFan(
      {
        telegramUserId: dialog.peerId,
        displayName: dialog.displayName,
        nickname: dialog.nickname,
        notes: dialog.notes,
        username: dialog.username,
      },
      user
    ),
  };
}

module.exports = {
  canViewFanUsername,
  canOpenChatByUsername,
  redactFan,
  redactDialog,
};
