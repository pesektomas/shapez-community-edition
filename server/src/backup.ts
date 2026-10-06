import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./db.ts";

/**
 * Writes a consistent copy of the database into dir, keeps the newest `keep` copies
 */
export function backupDatabase(store: Store, dir: string, keep = 7): string {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dir, `tvarovna-${stamp}.db`);
    store.backup(target);

    const backups = readdirSync(dir)
        .filter(name => /^tvarovna-.*\.db$/.test(name))
        .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
        rmSync(join(dir, old));
    }
    return target;
}
