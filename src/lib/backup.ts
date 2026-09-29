/* ────────────────────────────────────────────────────────────────────────────
   Reading a full backup back in.

   Settings > Storage has always been able to download a full backup (the
   settings profile and the whole filesystem) but never to restore one. That
   matters now: fixing the bottom band on an iPhone means removing the
   installed app and adding it again, and an installed iOS web app keeps its
   own storage, so the backup is how the files come across.

   A backup file is untrusted input: it is checked here, and what comes out is
   the two JSON strings the stores' own importers already validate
   (settings.importProfile, vfs.importAll). API keys are never in a backup.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

export type BackupRead =
  | { ok: true; settings: string | null; vfs: string | null; files: number; at: number | null }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The most a backup may be: the OS keeps everything in ~5 MB of local
 *  storage, so anything far bigger is not one of ours. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export function readBackup(text: string): BackupRead {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: "That file is too big to be a Web-AIOS backup." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not a Web-AIOS backup (it is not JSON)." };
  }
  if (!isObj(parsed) || parsed.__webaios_backup !== 1) {
    return { ok: false, error: "That file is not a Web-AIOS backup. Use the file from Download full backup." };
  }
  const settings = isObj(parsed.settings) ? JSON.stringify(parsed.settings) : null;
  const nodes = isObj(parsed.vfs) && isObj(parsed.vfs.nodes) ? parsed.vfs.nodes : null;
  const files = nodes ? Object.values(nodes).filter((n) => isObj(n) && "content" in n).length : 0;
  if (!settings && !nodes) return { ok: false, error: "The backup has no settings and no files in it." };
  return {
    ok: true,
    settings,
    vfs: nodes ? JSON.stringify({ __webaios_vfs: 1, nodes }) : null,
    files,
    at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : null,
  };
}
