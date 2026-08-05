const TEAM_ANALYTICS_ROLES = ['owner', 'manager'];
const TRACKED_STAFF_ROLES = ['chatter', 'team_leader'];

/**
 * Manager+ sees org-wide chatter + team_leader data.
 * Team Leader / Chatter see only their own rows.
 */
function isTeamAnalyticsRole(role) {
  return TEAM_ANALYTICS_ROLES.includes(role);
}

function getAnalyticsScope(user) {
  const role = user?.role || '';
  if (isTeamAnalyticsRole(role)) {
    return {
      mode: 'team',
      userIds: null,
      roles: TRACKED_STAFF_ROLES,
    };
  }
  return {
    mode: 'self',
    userIds: user?.id ? [user.id] : [],
    roles: TRACKED_STAFF_ROLES,
  };
}

/**
 * SQL fragment helpers for filtering messaging_dashboard_entries / users.
 * Returns { clause, params, nextIndex } where clause is empty string or
 * " AND col = ANY($n::uuid[])" / similar, and params are bind values.
 */
function chatterIdFilter(scope, column, startIndex = 1) {
  if (scope.mode === 'team') {
    return { clause: '', params: [], nextIndex: startIndex };
  }
  const idx = startIndex;
  return {
    clause: ` AND ${column} = ANY($${idx}::uuid[])`,
    params: [scope.userIds],
    nextIndex: startIndex + 1,
  };
}

function staffRoleFilter(scope, column, startIndex = 1) {
  if (scope.mode === 'self') {
    const idx = startIndex;
    return {
      clause: ` AND ${column} = ANY($${idx}::uuid[])`,
      params: [scope.userIds],
      nextIndex: startIndex + 1,
    };
  }
  const idx = startIndex;
  return {
    clause: ` AND ${column} = ANY($${idx}::text[])`,
    params: [TRACKED_STAFF_ROLES],
    nextIndex: startIndex + 1,
  };
}

module.exports = {
  TEAM_ANALYTICS_ROLES,
  TRACKED_STAFF_ROLES,
  isTeamAnalyticsRole,
  getAnalyticsScope,
  chatterIdFilter,
  staffRoleFilter,
};
