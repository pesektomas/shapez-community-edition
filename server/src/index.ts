import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "./app.ts";
import { backupDatabase } from "./backup.ts";

const env = process.env;

/** The Docker build writes the commit of the game build next to it */
function readBuildId(staticDir: string | undefined): string {
    const file = staticDir ? join(resolve(staticDir), "build-id.txt") : "";
    return file && existsSync(file) ? readFileSync(file, "utf-8").trim() : "";
}
const dataDir = resolve(env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });

const server = await createServer({
    dbPath: join(dataDir, "tvarovna.db"),
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : undefined,
    password: env.SERVER_PASSWORD ?? "",
    buildId: env.BUILD_ID ?? readBuildId(env.STATIC_DIR),
    sourceUrl: env.SOURCE_URL ?? "",
    snapshotIntervalTurns: env.SNAPSHOT_INTERVAL_TURNS ? Number(env.SNAPSHOT_INTERVAL_TURNS) : undefined,
    logLevel: env.LOG_LEVEL ?? "info",
});

const port = Number(env.PORT ?? 8080);
await server.app.listen({ port, host: env.HOST ?? "0.0.0.0" });

// Daily backup of the database (set BACKUP_INTERVAL_HOURS=0 to disable)
const backupHours = Number(env.BACKUP_INTERVAL_HOURS ?? 24);
const backupTimer =
    backupHours > 0
        ? setInterval(
              () => {
                  try {
                      const file = backupDatabase(
                          server.store,
                          join(dataDir, "backups"),
                          Number(env.BACKUP_KEEP ?? 7)
                      );
                      server.app.log.info({ file }, "database backup written");
                  } catch (err) {
                      server.app.log.error({ err }, "database backup failed");
                  }
              },
              backupHours * 3600 * 1000
          )
        : null;

async function shutdown(signal: string) {
    server.app.log.info({ signal }, "shutting down");
    if (backupTimer) {
        clearInterval(backupTimer);
    }
    await server.close();
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
