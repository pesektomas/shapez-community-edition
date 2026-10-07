// PM2 config for a VPS without Docker. Layout on the server (see deploy/deploy-vps.sh):
//   <dir>/server   server code (+ node_modules)
//   <dir>/shared   protocol shared with the client
//   <dir>/web      built game (npm run build:web)
//   <dir>/data     SQLite database and backups
//   <dir>/tvarovna.env   optional secrets, e.g. SERVER_PASSWORD=...
// Start / update:  pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save
const fs = require("node:fs");
const path = require("node:path");

/** Reads KEY=value lines from tvarovna.env next to this file, if it exists */
function readEnvFile() {
    const file = path.join(__dirname, "tvarovna.env");
    if (!fs.existsSync(file)) {
        return {};
    }
    const env = {};
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match) {
            env[match[1]] = match[2].replace(/^["']|["']$/g, "");
        }
    }
    return env;
}

module.exports = {
    apps: [
        {
            name: "tvarovna",
            cwd: path.join(__dirname, "server"),
            script: "src/index.ts",
            // PM2 would pick ts-node for .ts files, Node runs it natively
            interpreter: "node",
            interpreter_args: "--experimental-strip-types --disable-warning=ExperimentalWarning",
            // One process only: the worlds live in memory and in one SQLite file
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            max_memory_restart: "800M",
            // The server freezes the worlds cleanly on SIGTERM
            kill_timeout: 15000,
            env: {
                NODE_ENV: "production",
                PORT: "3100",
                HOST: "127.0.0.1",
                DATA_DIR: path.join(__dirname, "data"),
                STATIC_DIR: path.join(__dirname, "web"),
                SOURCE_URL: "https://github.com/pesektomas/shapez-community-edition",
                LOG_LEVEL: "info",
                ...readEnvFile(),
            },
        },
    ],
};
