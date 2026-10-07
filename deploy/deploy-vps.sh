#!/usr/bin/env bash
# Builds the game locally and deploys it with the server to a VPS running PM2.
#   deploy/deploy-vps.sh user@vps.example.com [/opt/tvarovna]
# Requirements: locally Node 22.13+, Java, ffmpeg, rsync; on the VPS Node 22.13+, PM2, rsync.
set -euo pipefail

TARGET="${1:?Usage: deploy/deploy-vps.sh user@host [remote_dir]}"
REMOTE_DIR="${2:-/opt/tvarovna}"
cd "$(dirname "$0")/.."

echo "==> Building the game"
npm run build:web
git rev-parse --short HEAD > build_output/web/build-id.txt

echo "==> Uploading to $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR/data' '$REMOTE_DIR/web' '$REMOTE_DIR/server' '$REMOTE_DIR/shared'"
rsync -az --delete build_output/web/ "$TARGET:$REMOTE_DIR/web/"
rsync -az --delete --exclude node_modules --exclude data server/ "$TARGET:$REMOTE_DIR/server/"
rsync -az --delete shared/ "$TARGET:$REMOTE_DIR/shared/"
rsync -az deploy/pm2/ecosystem.config.cjs "$TARGET:$REMOTE_DIR/"

echo "==> Installing dependencies and (re)starting with PM2"
ssh "$TARGET" "set -e
    cd '$REMOTE_DIR'
    node -e 'const [a,b]=process.versions.node.split(\".\").map(Number); if (a<22||(a===22&&b<13)) { console.error(\"Node 22.13+ required, found \"+process.versions.node); process.exit(1) }'
    cd server && npm ci --omit=dev --no-audit --no-fund && cd ..
    pm2 startOrReload ecosystem.config.cjs --update-env
    pm2 save
    sleep 2
    curl -fsS http://127.0.0.1:\$(node -e \"console.log(require('./ecosystem.config.cjs').apps[0].env.PORT)\")/healthz && echo"

echo "==> Done"
