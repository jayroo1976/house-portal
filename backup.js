const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA = process.env.DATA_DIR || '/data';
const BACKUPS = path.join(DATA, 'backups');
const UPLOADS = path.join(DATA, 'uploads');
const REMOTE = process.env.RCLONE_REMOTE || ''; // e.g. onedrive:HouseProjects
const KEEP = parseInt(process.env.BACKUP_KEEP || '14', 10);

const status = { running: false, lastRun: null, lastOk: null, lastError: null, lastFile: null, remote: REMOTE || null };

function rclone(args) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().slice(0, 800)));
      else resolve(stdout);
    });
  });
}

async function runBackup(db) {
  if (status.running) throw new Error('Backup already running');
  status.running = true;
  status.lastRun = new Date().toISOString();
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUPS, `house-${stamp}.db`);
    await db.backup(file); // consistent online snapshot
    status.lastFile = path.basename(file);

    // retention (local)
    const snaps = fs.readdirSync(BACKUPS).filter(f => f.startsWith('house-') && f.endsWith('.db')).sort();
    while (snaps.length > KEEP) fs.unlinkSync(path.join(BACKUPS, snaps.shift()));

    if (REMOTE) {
      // copy (never delete remotely) so a bad local state can't wipe the cloud copy
      await rclone(['copy', BACKUPS, `${REMOTE}/backups`]);
      await rclone(['copy', UPLOADS, `${REMOTE}/uploads`]);
    }
    status.lastOk = new Date().toISOString();
    status.lastError = REMOTE ? null : 'Local backup only: RCLONE_REMOTE not set';
  } catch (e) {
    status.lastError = e.message;
    throw e;
  } finally {
    status.running = false;
  }
  return status;
}

module.exports = { runBackup, status };
