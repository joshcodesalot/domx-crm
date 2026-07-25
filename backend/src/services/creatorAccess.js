const pool = require('../db/pool');

const ROLES_SEEING_ALL_CREATORS = ['owner', 'manager'];

function userSeesAllCreators(user) {
  return (
    user.permissions.includes('creators.manage') ||
    ROLES_SEEING_ALL_CREATORS.includes(user.role)
  );
}

async function userCanAccessCreator(user, creatorId) {
  if (userSeesAllCreators(user)) {
    return true;
  }

  const result = await pool.query(
    `SELECT 1
     FROM creator_staff_assignments
     WHERE "creatorId" = $1 AND "userId" = $2`,
    [creatorId, user.id]
  );

  return result.rows.length > 0;
}

async function getUserIdsWithCreatorAccess(creatorId) {
  const [assigned, managers] = await Promise.all([
    pool.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [creatorId]
    ),
    pool.query(
      `SELECT id FROM users
       WHERE status = 'active' AND role = ANY($1::text[])`,
      [ROLES_SEEING_ALL_CREATORS]
    ),
  ]);

  return [
    ...new Set([
      ...assigned.rows.map((row) => row.userId),
      ...managers.rows.map((row) => row.id),
    ]),
  ];
}

module.exports = {
  ROLES_SEEING_ALL_CREATORS,
  userSeesAllCreators,
  userCanAccessCreator,
  getUserIdsWithCreatorAccess,
};
