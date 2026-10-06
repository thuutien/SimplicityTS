// Makes a safe copy of the database, even while the app is running.
// Usage: node scripts/backup-db.js [label]
// Backups go to BACKUP_DIR (from .env), or the "backups" folder next to the app.
// Only the newest BACKUP_KEEP backups (default 30) are kept.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const appDir = path.join(__dirname, '..');
try {
  process.loadEnvFile(path.join(appDir, '.env'));
} catch {
  // No .env file: use defaults
}

const dbPath = process.env.DB_PATH || path.join(appDir, 'tickets.db');
const backupDir = process.env.BACKUP_DIR || path.join(appDir, 'backups');
const keep = Number(process.env.BACKUP_KEEP || 30);
const label = (process.argv[2] || 'daily').replace(/[^a-z0-9-]/gi, '');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261006-142530
const target = path.join(backupDir, `tickets-${stamp}-${label}.db`);

// VACUUM INTO writes a consistent copy even if the app is writing at the same time.
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup saved: ${target}`);

// Remove the oldest backups beyond the limit
const backups = fs.readdirSync(backupDir)
  .filter(f => /^tickets-\d{8}-\d{6}-.*\.db$/.test(f))
  .sort()
  .reverse();
for (const old of backups.slice(keep)) {
  fs.unlinkSync(path.join(backupDir, old));
  console.log(`Removed old backup: ${old}`);
}
