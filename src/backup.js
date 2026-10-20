import fs from 'node:fs';

export const BACKUP_SUFFIX = '.quelltest-backup';

/**
 * Verification mutates source files in place and keeps the original next to them.
 * If a previous run was killed before it could restore, put the original back. Returns true when a repair happened.
 */
export function restoreIfInterrupted(sourceFile) {
  const backup = sourceFile + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return false;
  fs.copyFileSync(backup, sourceFile);
  fs.rmSync(backup);
  return true;
}
