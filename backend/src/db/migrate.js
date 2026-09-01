const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const TABLE_MARKERS = {
  '037_scheduled_content.sql': 'scheduled_content_jobs',
  '041_telegram_platform.sql': 'telegram_fan_profiles',
  '044_telegram_vault.sql': 'telegram_vault_folders',
  '046_telegram_sexting_sessions.sql': 'telegram_sexting_sessions',
  '048_schedule_unsend_before_mass.sql': 'app_settings',
  '049_throne_notifications.sql': 'throne_notifications',
  '050_telegram_lists_and_mm.sql': 'telegram_lists',
  '051_telegram_global_fan_notes.sql': 'telegram_fan_notes',
};

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.exists);
}

async function bootstrapExistingDatabase(client, files) {
  const counted = await client.query('SELECT COUNT(*)::int AS count FROM schema_migrations');
  if (counted.rows[0].count > 0) return false;

  const users = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `);
  if (!users.rows[0].exists) return false;

  for (const file of files) {
    const marker = TABLE_MARKERS[file];
    if (marker && !(await tableExists(client, marker))) {
      continue;
    }
    await client.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [file]
    );
  }
  return true;
}

async function migrate() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const bootstrapped = await bootstrapExistingDatabase(client, files);
    if (bootstrapped) {
      console.log('Recorded existing schema as applied. Future migrate runs will only apply new files.');
    }

    const applied = await client.query('SELECT id FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map((row) => row.id));

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      console.log(`Migration completed: ${file}`);
      ran += 1;
    }

    if (ran === 0) {
      console.log('No pending migrations.');
    }
    console.log('All migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
