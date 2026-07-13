const pool = require('../db/pool');

function userSeesAllCreators(user) {
  return (
    user.permissions.includes('creators.manage') || user.role !== 'chatter'
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

module.exports = {
  userSeesAllCreators,
  userCanAccessCreator,
};
