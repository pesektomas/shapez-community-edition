# Tvarovna: co-op režim

Webová co-op verze shapez CE. Všichni hráči jsou v jednom světě. Server řadí
akce do tahů (deterministický lockstep) a hru nesimuluje.

## Rychlý start

Potřeba je Node 22.13 nebo novější. Server běží jako TypeScript přes `--experimental-strip-types`, bez buildu.
Na sestavení hry je potřeba Java a ffmpeg.

```sh
# Docker (hra + server v jednom kontejneru)
docker compose up -d --build
# → http://localhost:8080

# Bez Dockeru (vývoj)
npm ci && npm run build:web          # nebo build:web-dev s testovacími háčky
cd server && npm ci
STATIC_DIR=../build_output/web npm start

# Vývoj: terminál 1 průběžně sestavuje hru do build/, terminál 2 pouští server
npm run serve:web
cd server && STATIC_DIR=../build npm run dev   # → http://localhost:8080 (port 3005 je jen statika bez serveru)
```

Organizátor otevře `/`, zadá přezdívku, zvolí start (level 1, 7 nebo 27) a klikne na
„Založit svět“. V adresním řádku (a pod tlačítkem „Zkopírovat pozvánku“ ve hře) je
odkaz `/w/<worldId>?k=<inviteKey>`. Ten se pošle ostatním.

### Proměnné prostředí serveru

| Proměnná                  | Výchozí            | Popis                                                               |
| ------------------------- | ------------------ | ------------------------------------------------------------------- |
| `PORT`                    | `8080`             | HTTP + WebSocket (`/ws`)                                            |
| `DATA_DIR`                | `./data` (`/data`) | SQLite `tvarovna.db` a zálohy v `backups/`                          |
| `STATIC_DIR`              | –                  | Adresář se sestavenou hrou (`build_output/web`)                     |
| `SERVER_PASSWORD`         | –                  | Volitelné heslo pro zakládání a připojování                         |
| `SOURCE_URL`              | –                  | Odkaz na zdrojáky v patičce (GPL)                                   |
| `BUILD_ID`                | `build-id.txt`     | Očekávaná verze klienta. Jiný build dostane hlášku „obnov stránku“. |
| `SNAPSHOT_INTERVAL_TURNS` | `600`              | Jak často leader posílá snapshot (600 tahů = 60 s)                  |
| `BACKUP_INTERVAL_HOURS`   | `24`               | Interval zálohy databáze (`VACUUM INTO`), `0` vypne                 |
| `BACKUP_KEEP`             | `7`                | Počet uchovaných záloh                                              |
| `LOG_LEVEL`               | `info`             | Logy jsou JSON na stdout                                            |

HTTP API: `POST /api/worlds`, `GET /api/worlds/:id?k=`, `GET /api/config`, `GET /healthz`.

## Architektura

```
shared/protocol.ts       zprávy, akce, konstanty (100 ms tah = 6 ticků při 60 tps)
server/src/              fastify + ws + node:sqlite
  room.ts                tahy, join/resume, hashe → desync → resync, snapshoty
  db.ts                  worlds, snapshots (poslední 3), action_log, players
src/js/net/              klient
  coop_session.ts        lockstep řízení ticků, aplikace akcí, hash, undo
  lockstep.ts            fronta tahů, plánování ticků a dohánění
  actions.ts             applyAction + validace (stejná na všech klientech)
  snapshot.ts            bezztrátový savegame + stav, který savegame neukládá
  state_hash.ts          kanonický stav → 64bit hash
  coop_connection.ts     WebSocket, welcome/resync/reconnect
  hud/                   hráči, chat, kurzory, ghosty, notifikace
src/js/game/modes/coop.ts  CoopGameMode (60 tps, seed, startovní level)
src/js/states/coop.ts      úvodní stránka
```

Zásahy do původního kódu hry jsou označené `// COOP:`.

### Tok tahu

1. HUD místo změny stavu zavolá `root.coop.dispatch(akce)`. Akce jde na server a
   lokálně se jen zobrazí jako „ghost“.
2. Server každých 100 ms uzavře tah `n` se všemi došlými akcemi, zapíše ho do
   `action_log` a rozešle.
3. Klient na začátku tahu `n` aplikuje jeho akce ve stejném pořadí a pak spustí 6 ticků.
   Simulovat smí jen do posledního přijatého tahu.
4. Každých 50 tahů pošle hash stavu. Když se hash některého hráče liší od většiny,
   server si vyžádá snapshot od leadera (při remíze vyhrává leader) a pošle ho
   rozjetým klientům (`resync`).
5. Leader (nejdéle připojený hráč) posílá každých 600 tahů snapshot. Nový hráč
   dostane poslední snapshot a tahy od něj a simulaci dožene.

### Odolnost

-   **Výpadek sítě:** klient se znovu připojí (backoff 0,25–8 s) s `resumeFromTurn`.
    Dostane jen chybějící tahy, bez reloadu. Neodeslané akce se pošlou znovu a server
    duplicity zahodí podle `clientSeq`.
-   **Restart serveru:** po pádu server pokračuje od posledního známého tahu + 50.
    Čísla tahů se tak nikdy nepoužijí dvakrát. Po čistém zastavení pokračuje přesně.
-   **Všichni odešli:** svět se zmrazí (žádné tahy) a příště pokračuje od stejného ticku.
-   **Limity:** 10 hráčů na svět, 60 akcí/s (burst 300), akce max 512 kB,
    zpráva max 8 MB, chat 300 znaků.

## Testy

```sh
cd server && npm test                    # vrstvy 1–2: server, protokol s boty (node:test)
npm run build:web-dev                    # testovací build s window.__coop
npm run test:e2e                         # vrstvy 3, 5–7 v Chromiu
npx playwright test -c e2e/playwright.config.ts --project=firefox --project=webkit -g golden   # vrstva 4
FUZZ_SEED=123 npm run test:e2e -- tests/fuzz.spec.ts   # přehrání padlého fuzz běhu
MP_DURATION_S=600 npm run test:e2e -- tests/multiplayer.spec.ts -g concurrent   # soak
cd server && npm run bots                # vrstva 8: zátěž (50 světů × 10 botů)
npm run desync:diff -- test-results/desync/<x>-a.json test-results/desync/<x>-b.json
```

| Soubor                          | Co testuje                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `server/test/server.test.ts`    | tahy po 100 ms, pořadí, invite, verze, limity, perzistence, desync, resume     |
| `server/test/protocol.test.ts`  | 10 botů dostane identické tahy, reconnect bez ztráty tahu                      |
| `e2e/tests/determinism.spec.ts` | 9 scénářů: replay ve 2 instancích, golden hashe, snapshot = běžící hra         |
| `e2e/tests/fuzz.spec.ts`        | náhodné platné i neplatné akce, seedované                                      |
| `e2e/tests/multiplayer.spec.ts` | 3 hráči staví současně, pozdní připojení přes snapshot                         |
| `e2e/tests/robustness.spec.ts`  | offline 30 s, vynucený desync, pád serveru, odchod všech, latence 150 ± 100 ms |
| `e2e/tests/ui.spec.ts`          | myš: stavění, mazání, undo, chat přes server                                   |

Golden hashe (`e2e/golden-hashes.json`) se po úmyslné změně simulace přegenerují
příkazem `UPDATE_GOLDEN=1 npm run test:e2e -- -g golden`. Platí pro dev build.

Pomocný skript `e2e/debug-entities.ts <scénář> [tah]` vypíše budovy a jejich stav,
když scénář nedělá, co má.

## Nasazení

### VPS bez Dockeru (PM2 + nginx)

Hra se sestaví na vývojářském stroji (Java a ffmpeg na VPS nejsou potřeba) a na
VPS se nahraje hotová. Na VPS stačí Node 22.13+, PM2 a rsync.

```sh
# jednou na VPS: heslo serveru (volitelné) a nginx s HTTPS
ssh user@vps 'mkdir -p /opt/tvarovna && echo "SERVER_PASSWORD=..." > /opt/tvarovna/tvarovna.env'
# deploy/nginx/tvarovna.conf → /etc/nginx/sites-available/, upravit doménu, certbot --nginx

# při každém nasazení, z kořene repa na vývojářském stroji
deploy/deploy-vps.sh user@vps            # výchozí adresář /opt/tvarovna, port 3100

# aby PM2 naběhl po restartu VPS (jednou)
ssh user@vps 'pm2 startup'               # vypíše příkaz se sudo, ten spustit
```

`deploy/pm2/ecosystem.config.cjs` spouští jeden proces (`instances: 1`, světy jsou v
paměti a v jednom SQLite souboru) na `127.0.0.1:3100`. Port se mění v ecosystem
souboru a v nginx konfiguraci. Data jsou v `/opt/tvarovna/data`, zálohy v `data/backups`.
Po nasazení nové verze dostanou připojení hráči hlášku „obnov stránku“.

### Docker

-   `Dockerfile`: multi-stage build (hra s ffmpeg a Javou → serverové závislosti →
    `node:22-slim`). Builder pro Electron je v `Dockerfile.builder`.
-   `docker-compose.yml`: lokálně nebo na VPS, volume `tvarovna-data`. Před server
    patří TLS proxy (Caddy, Traefik, Cloudflare Tunnel). WebSocket jde přes `/ws`.
-   `deploy/k8s/tvarovna.yaml`: Deployment s 1 replikou (`Recreate`), PVC, Service
    a Ingress (nginx s timeouty pro WebSocket).
-   Zálohy: server každých 24 h zapíše konzistentní kopii do `/data/backups`.
    Z clusteru nebo VPS je potřeba je kopírovat jinam.
