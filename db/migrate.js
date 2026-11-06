'use strict';
/**
 * NexaMOS Identity API — Database Migration Runner
 * Jalankan: node db/migrate.js
 */

require('dotenv').config();
const mysql2 = require('mysql2/promise');
const fs     = require('fs');
const path   = require('path');

async function runMigrations() {
  const conn = await mysql2.createConnection({
    host:     process.env.IAM_DB_HOST     || 'srv1412.hstgr.io',
    port:     Number(process.env.IAM_DB_PORT) || 3306,
    user:     process.env.IAM_DB_USER,
    password: process.env.IAM_DB_PASSWORD,
    database: process.env.IAM_DB_NAME     || 'u294320793_nexamain',
    multipleStatements: true,
  });

  console.log('[Migrate] Connected to MySQL:', process.env.IAM_DB_NAME);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    console.log(`[Migrate] Running: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await conn.query(sql);
    console.log(`[Migrate] ✅ Done: ${file}`);
  }

  // Jalankan seeds jika ada flag --seed
  if (process.argv.includes('--seed')) {
    const seedsDir = path.join(__dirname, 'seeds');
    const seedFiles = fs.readdirSync(seedsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of seedFiles) {
      console.log(`[Seed] Running: ${file}`);
      const sql = fs.readFileSync(path.join(seedsDir, file), 'utf8');
      await conn.query(sql);
      console.log(`[Seed] ✅ Done: ${file}`);
    }
  }

  await conn.end();
  console.log('[Migrate] ✅ All migrations complete!');
}

runMigrations().catch(err => {
  console.error('[Migrate] ❌ Error:', err.message);
  process.exit(1);
});

