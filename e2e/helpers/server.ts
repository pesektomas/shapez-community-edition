import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function freePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => resolvePort(port));
        });
        server.on("error", reject);
    });
}

export interface CoopServerProcess {
    baseURL: string;
    port: number;
    dataDir: string;
    logs: string[];
    /** Stops the server gracefully */
    stop(): Promise<void>;
    /** Kills the server without a clean shutdown (crash) */
    kill(): Promise<void>;
    /** Starts the server again on the same port and data directory */
    start(): Promise<void>;
}

/**
 * Starts the real co-op server with the dev build of the game. When
 * E2E_SERVER_URL is set (e.g. docker compose in CI), that server is used.
 */
export async function startCoopServer(env: Record<string, string> = {}): Promise<CoopServerProcess> {
    const port = await freePort();
    const dataDir = mkdtempSync(join(tmpdir(), "tvarovna-e2e-"));
    const logs: string[] = [];
    let child: ChildProcess | null = null;

    const instance: CoopServerProcess = {
        baseURL: `http://127.0.0.1:${port}`,
        port,
        dataDir,
        logs,
        async start() {
            child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/index.ts"], {
                cwd: join(repoRoot, "server"),
                env: {
                    ...process.env,
                    PORT: String(port),
                    HOST: "127.0.0.1",
                    DATA_DIR: dataDir,
                    STATIC_DIR: join(repoRoot, "build_output", "web-dev"),
                    LOG_LEVEL: "info",
                    BACKUP_INTERVAL_HOURS: "0",
                    ...env,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout.on("data", data => logs.push(String(data)));
            child.stderr.on("data", data => logs.push(String(data)));

            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                try {
                    const res = await fetch(`${instance.baseURL}/healthz`);
                    if (res.ok) {
                        return;
                    }
                } catch {
                    // Not up yet
                }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error("Server did not start:\n" + logs.join(""));
        },
        async stop() {
            await stopChild("SIGTERM");
        },
        async kill() {
            await stopChild("SIGKILL");
        },
    };

    async function stopChild(signal: NodeJS.Signals) {
        const current = child;
        if (!current || current.exitCode !== null) {
            return;
        }
        await new Promise<void>(resolveExit => {
            current.once("exit", () => resolveExit());
            current.kill(signal);
        });
        child = null;
    }

    await instance.start();
    return instance;
}
