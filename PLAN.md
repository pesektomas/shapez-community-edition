# Shapez Co-op — plán projektu

**Pracovní název:** Tvarovna (veřejně nepoužívat název „shapez“, viz Licence).
**Cíl:** webová co-op verze hry shapez, kterou si tým zahraje v prohlížeči přes sdílený odkaz.

Tento dokument je zadání pro Claude Code. Postupuj po fázích, každou fázi zakonči commitem a ověřením podle „Hotovo, když“.

## Stav fází

| Fáze                              | Stav           | Poznámka                                                                             |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| 0 – Příprava a audit determinismu | ✅             | `upstream` remote, audit v [docs/DETERMINISM.md](docs/DETERMINISM.md)                |
| 1 – Webový build                  | ✅ (Chromium)  | `npm run build:web` → `build_output/web`, viz [docs/WEB_BUILD.md](docs/WEB_BUILD.md) |
| 2 – Deterministické jádro offline | ✅             | lockstep, akce, bezztrátový snapshot, 9 scénářů, golden hashe                        |
| 3 – Server a netcode              | ✅             | `server/` (fastify, ws, node:sqlite), join přes snapshot                             |
| 4 – Co-op UX                      | ✅             | úvodní stránka, pozvánky, hráči, chat, kurzory, ghosty, notifikace, undo             |
| 5 – Robustnost                    | ✅             | resync, reconnect, kontrola verze, limity, E2E 3–7, fuzz                             |
| 6 – Nasazení                      | ✅ (neověřeno) | Dockerfile, compose, k8s, CI. Docker build a veřejnou doménu tu nešlo ověřit         |
| 7 – Playtest                      | —              | na týmu                                                                              |

Spuštění, nasazení a testy: [docs/COOP.md](docs/COOP.md).

## 1. Shrnutí v jednom odstavci

Forkneme shapez Community Edition (open source, GPL-3.0, JS/TS, vlastní canvas engine), vrátíme mu webový build a přidáme co-op režim: všichni hráči jsou v jednom sdíleném světě se společným HUBem, levely a upgrady. Síťování je deterministic lockstep (stejně jako Factorio): po síti se posílají jen akce hráčů („postav pás na x,y“), simulaci si každý prohlížeč počítá sám. Malý Node.js server přes WebSocket řadí akce do „tahů“, drží snapshot světa a rozesílá ho nově připojeným. Celé to poběží jako jeden Docker kontejner.

## 2. Výchozí stav (ověřeno v repu)

Repo: https://github.com/tobspr-games/shapez-community-edition, aktivní, poslední commit 8/2026.

-   **Licence:** GPL-3.0-or-later.
-   **Build:** Node 22, gulp a rspack, potřebuje ffmpeg a Java (texture packer). V repu je hotový Dockerfile pro build.
-   **Pouze Electron:** CE oficiálně nepodporuje webový build. Úložiště `src/js/platform/storage.ts` a `wrapper.js` volají `ipcRenderer`. Tohle musíme nahradit webovou platformou (fáze 1).
-   **Herní smyčka je vhodná pro lockstep:**
    -   `game_time.js` už má fixní krok s rozpočtem času. Logika používá `timeSeconds` z deltaTicku, ne reálný čas.
    -   `realtimeNow()` se používá jen pro animace pásů (`belt.js`, `belt_underlays.js`), tedy pro render, ne pro logiku.
    -   `DynamicTickrate` mění tickrate podle FPS, což je pro lockstep nepřípustné. Herní režim ale umí vrátit `getFixedTickrate()` (používá ho puzzle mód), takže co-op režim nastaví pevných 60 ticků/s.
    -   Freeplay tvary se generují seedovaně (`hub_goals.js`: `RandomNumberGenerator(map.seed + "/" + level)`). Seed se přenáší v savegame.
-   **Levely:** `src/js/game/modes/levels.js` obsahuje 26 levelů a pak nekonečný freeplay.
-   **Savegame:** `savegame_serializer.js` serializuje celý stav (map, entity, beltPaths, hubGoals, time). Použijeme ho jako snapshot pro připojení a pro perzistenci.
-   **Místa, kde HUD mění stav hry** (budou se přesměrovávat na akce):
    -   `hud/parts/building_placer_logic.js`: stavění, přes `logic.tryPlaceBuilding`
    -   `hud/parts/mass_selector.js`: hromadné mazání a vyjmutí
    -   `hud/parts/blueprint_placer.js`: vkládání blueprintů
    -   `hud/parts/shop.js`: nákup upgradů, přes `hubGoals.tryUnlockUpgrade`
    -   `hud/parts/constant_signal_edit.js`, `hud/parts/lever_toggle.js`: dráty a signály
    -   `hud/parts/waypoints.js`: značky na mapě (sdílené)
    -   `logic.js`: `tryPlaceBuilding`, `tryDeleteBuilding`, `performBulkOperation`

## 3. Jak hra bude fungovat (game design)

### Princip

-   Jeden sdílený svět na jednu „místnost“. Všichni mají společný HUB, společný postup levely a společné upgrady.
-   Kdokoli staví kdekoli. V MVP nejsou oprávnění ani zóny, spoléháme na kolegialitu.
-   Upgrady v obchodě může koupit kdokoli. Nákup se všem oznámí („Pavel koupil Pásy III“).
-   Dokončení levelu je společná oslava. Notifikace všem a odemčení pro všechny.
-   Svět běží, jen když je online aspoň 1 hráč. Když všichni odejdou, svět se zmrazí a příště pokračuje přesně tam, kde skončil.
-   Pauza a zrychlení času jsou v co-op vypnuté.
-   Undo (Ctrl+Z) vrací jen vlastní akce hráče a posílá je jako normální akce.

### Volba startu při zakládání světa

| Režim                                               | Pro koho                 | Co se stane                                                                                                 |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Od začátku (level 1) — doporučeno pro první session | smíšený tým, nováčci     | Klasický průchod. Prvních ~5 levelů funguje jako tutoriál, za první večer se dá dojít zhruba k levelu 8–10. |
| Rychlý start (level 7)                              | lidé, kteří shapez znají | Odemčené balancery, rotátory, tunely, lakovna a stacker. Rovnou se staví větší linky.                       |
| Freeplay (level 27+)                                | dlouhodobý server        | Všechno odemčené, náhodné seedované cíle a soutěž v efektivitě.                                             |

Implementace: `CoopGameMode extends RegularGameMode`, při vytvoření světa se nastaví `hubGoals.level` a odemknou se odměny z předchozích levelů.

### Prvky pro týmovou hru (MVP)

-   Kurzory ostatních hráčů s jménem a barvou, přenášené zhruba 10× za sekundu, mimo lockstep.
-   Seznam hráčů online (pravý horní roh).
-   Sdílené waypointy: „Tady dělám lakovnu“.
-   Jednoduchý textový chat (Enter).
-   Notifikace: level dokončen, upgrade koupen, hráč přišel nebo odešel.

### Mimo MVP (později)

-   Týmový závod: 2 týmy a 2 HUBy na jedné mapě, kdo dřív dojde k levelu X.
-   Oprávnění a zóny, přihlášení přes Google SSO, statistiky „kdo co postavil“.
-   Mobil a dotyk. Shapez na web na dotyk stavěný není, cílíme na desktopový prohlížeč (Chrome, Firefox, Safari).

## 4. Jak se lidé připojí

1. Organizátor otevře `https://<domena>/`, zadá přezdívku a klikne na „Nový svět“, kde zvolí režim startu.
2. Dostane pozvánkový odkaz `https://<domena>/w/<worldId>?k=<inviteKey>` a pošle ho do Slacku nebo Discordu.
3. Kolega odkaz otevře, zadá přezdívku (uloží se do localStorage) a během pár sekund je ve hře.
4. Svět i odkaz platí trvale. Příště stačí stejný odkaz, nebo seznam „Moje světy“ na úvodní stránce.
5. Hlas: Discord, Meet nebo Slack huddle vedle, hra vlastní hlas neřeší.

Zabezpečení v MVP: `inviteKey` je náhodný token (128 bit) a kdo ho nemá, nepřipojí se. Volitelně jde přidat globální heslo serveru přes env proměnnou `SERVER_PASSWORD`.

## 5. Technologie a stack

### Klient (fork CE)

-   Stávající engine shapez: JS/TS, Canvas 2D, gulp a rspack. Engine neměníme.
-   Nová webová platforma: `src/js/platform/web/` obsahuje storage přes IndexedDB (lokální nastavení) a wrapper bez Electronu. Savegame v co-op žije na serveru.
-   Nový modul `src/js/net/` (TypeScript):
    -   `net_client.ts`: WebSocket, reconnect, ping
    -   `actions.ts`: typy akcí, serializace, `applyAction(root, action)`
    -   `lockstep.ts`: fronta tahů a řízení, kolik ticků se smí simulovat
    -   `state_hash.ts`: hash stavu pro detekci desyncu
    -   `presence.ts`: kurzory, hráči, chat
-   Nový režim `src/js/game/modes/coop.ts` (`CoopGameMode`): `getFixedTickrate()` → 60, vypnutá pauza, vypnutý lokální autosave a startovní level podle nastavení světa.
-   Úprava HUD částí ze sekce 2 tak, aby místo přímé mutace vytvořily akci a poslaly ji na server. Lokálně se hned ukáže jen „ghost“ náhled.
-   Zprávy: msgpack (`@msgpack/msgpack` už je v závislostech).

### Server

-   Node.js 22 + TypeScript, `ws` (WebSocket), `fastify` (HTTP API a statické soubory klienta).
-   Úložiště: SQLite (`better-sqlite3`) pro tabulky `worlds`, `snapshots` a `action_log`. Jeden soubor na volume, záloha je triviální.
-   Jedna místnost = jeden svět v paměti, při startu serveru se načte lazy.
-   Žádná herní logika na serveru. Server je jen hodiny a pošťák: řadí akce, rozesílá tahy, ukládá snapshoty a porovnává hashe.

### Struktura repa (GitHub fork CE pojmenovaný tvarovna, hra zůstává v kořeni)

```
tvarovna/
  src/, res/, gulp/, electron/ …   # původní shapez CE
  server/          # Node + TS server
  shared/          # protokol: typy zpráv a akcí (sdíleno klient↔server)
  e2e/             # Playwright testy (2+ klienti, porovnání hashe)
  Dockerfile       # multi-stage: build game → build server → runtime
  docker-compose.yml
  PLAN.md
```

## 6. Síťová architektura (lockstep)

```
 Klient A ──akce──►┐                    ┌──► Klient A
 Klient B ──akce──►│  SERVER (Node)     │──► Klient B
 Klient C ──akce──►┘  každých 100 ms:   └──► Klient C
                      TAH n = [akce…]
                      (1 tah = 6 ticků při 60 tps)
```

1. **Tahy:** server každých 100 ms uzavře tah n se všemi akcemi, které mezitím dorazily, a v pevném pořadí ho rozešle všem.
2. **Klient simuluje jen do konce posledního přijatého tahu.** Na začátku tahu aplikuje jeho akce ve stejném pořadí, pak spustí 6 ticků. Vstupní zpoždění je zhruba 100–200 ms, což je u budovatelské hry nepostřehnutelné, protože ghost náhled je okamžitý.
3. **Pomalý klient** dohání víc ticky za frame. Když zaostává o víc než 5 s, ukáže se varování a případně resync.
4. **Hash stavu:** každých 50 tahů (5 s) pošle klient hash stavu (entity count + uid/pozice/rotace budov + hubGoals + položky na pásech, FNV-1a nebo xxhash). Server hashe porovná.
5. **Desync:** pokud se hash liší, server si vyžádá snapshot od „leadera“ (nejdéle připojený klient s většinovým hashem) a rozešle ho klientům mimo shodu, kteří se tiše znovu načtou. Do logu se zapíše tah a typy akcí kvůli debugování.
6. **Snapshot a perzistence:** leader každých 60 s pošle savegame (msgpack + komprese) zarovnanou na hranici tahu. Server uloží snapshot a od něj vede action log.
7. **Připojení hráče:** dostane poslední snapshot + akce od snapshotu. Simulaci dožene rychlostí přes maximálně ~3600 ticků (pár sekund) a pak jede normálně. Ostatní hráči nic nečekají.
8. **Restart serveru:** svět se obnoví ze snapshotu + action logu.
9. **Mimo lockstep** (přímo broadcast, nedeterministické): kurzory, chat, ping.

### Protokol (`shared/protocol.ts`)

```
C→S  hello      { worldId, inviteKey, name, clientVersion }
C→S  action     { clientSeq, type, payload }
C→S  hash       { turn, hash }
C→S  snapshot   { turn, data }            // jen leader, na vyžádání nebo periodicky
C→S  cursor     { x, y, layer }
C→S  chat       { text }

S→C  welcome    { playerId, color, world, snapshot, snapshotTurn, turnsSince[] }
S→C  turn       { n, actions: [{ playerId, clientSeq, type, payload }] }
S→C  players    { list }
S→C  cursor     { playerId, x, y, layer }
S→C  chat       { playerId, text }
S→C  requestSnapshot { turn }
S→C  resync     { snapshot, snapshotTurn, turnsSince[] }
S→C  error      { code, message }
```

### Typy akcí (MVP)

`placeBuilding`, `deleteBuildings` (seznam uid), `pasteBlueprint` (serializovaný blueprint + origin), `unlockUpgrade`, `setConstantSignal`, `toggleLever`, `addWaypoint`, `removeWaypoint`.

Každá akce se na klientu validuje stejně jako dnes (např. `checkCanPlaceEntity`). Nevalidní akce se deterministicky ignoruje na všech klientech.

## 7. Fáze a postup

### Fáze 0: Příprava a audit determinismu (≈ 1 den)

-   Fork už existuje (tvarovna). Přidat upstream remote na CE, uložit tento plán do PLAN.md, zprovoznit build lokálně i v Dockeru.
-   Audit determinismu herní logiky (`src/js/game/systems`, `logic.js`, `hub_goals.js`, `belt_path.js`):
    -   `Math.random`, `Date.now`, `performance.now`, `realtimeNow` v logice (ne v renderu)
    -   transcendentní funkce (`Math.sin/cos/pow/exp/atan2`) v logice, které se mohou lišit mezi enginy
    -   iterace přes objekty a Map v pořadí závislém na čase vložení
    -   generování uid entit (musí to být deterministický čítač)
    -   kód závislý na FPS nebo DynamicTickrate
-   Výstup: `docs/DETERMINISM.md` se seznamem nálezů a návrhem oprav.
-   **Hotovo, když:** CE jde sestavit a spustit a audit je sepsaný.

### Fáze 1: Webový build (≈ 1–2 dny)

-   Webová platforma (storage přes IndexedDB, wrapper bez `ipcRenderer`, fullscreen přes Fullscreen API).
-   Gulp úloha `build.web`, jejímž výstupem je statický adresář `build_output/web`.
-   Vypnout nebo odstranit Electron-only věci (Steam, externí soubory).
-   **Hotovo, když:** single-player hra běží v Chrome, Firefoxu a Safari ze statického serveru a ukládá se do IndexedDB.

### Fáze 2: Deterministické jádro offline (≈ 2 dny)

-   `CoopGameMode` s fixním tickratem 60.
-   Vrstva akcí: všechny mutace ze sekce 2 jdou přes `dispatchAction()` → (zatím lokální) fronta → `applyAction()` na začátku tahu.
-   Guard v dev režimu: pokud se entita přidá nebo smaže mimo `applyAction()` nebo herní systémy, vyhodí se assert. Tak se odhalí zapomenuté cesty.
-   `state_hash.ts`.
-   Test: nahrát sekvenci akcí, přehrát ji ve dvou instancích (Playwright, 2 taby) a ověřit shodný hash po 10 000 ticků. Přidat i variantu Chromium vs. Firefox.
-   **Hotovo, když:** e2e replay test je zelený a opakovaně stabilní.

### Fáze 3: Server a netcode (≈ 2–3 dny)

-   `server/`: fastify + ws, místnosti, smyčka tahů po 100 ms, SQLite (`worlds`, `snapshots`, `action_log`).
-   HTTP API: `POST /api/worlds` (vytvoř svět → `worldId` + `inviteKey`), `GET /api/worlds/:id` (meta).
-   Klient: `net_client.ts` a `lockstep.ts`, napojení `dispatchAction` na server.
-   Join přes snapshot + replay, periodické snapshoty od leadera.
-   **Hotovo, když:** 3 prohlížeče se připojí ke stejnému světu, staví současně, po 10 minutách mají shodný hash a pozdě připojený hráč vidí totéž.

### Fáze 4: Co-op UX (≈ 2 dny)

-   Úvodní stránka: přezdívka, „Nový svět“ (volba startu), „Moje světy“, vstup přes odkaz.
-   Kurzory, seznam hráčů, chat, sdílené waypointy, notifikace.
-   Startovní level podle režimu (1 / 7 / 27).
-   Vypnout pauzu, zrychlení času a lokální autosave. Undo omezit jen na vlastní akce.
-   **Hotovo, když:** nováček se připojí přes odkaz bez vysvětlování a hned vidí ostatní.

### Fáze 5: Robustnost (≈ 1 den)

-   Porovnávání hashů a automatický resync.
-   Reconnect po výpadku Wi-Fi (návrat bez reloadu, dohnání tahů).
-   Kontrola verze klienta proti serveru, při neshodě hláška „obnov stránku“.
-   Limity: max. 10 hráčů na svět, rate-limit akcí, maximální velikost zprávy.
-   **Hotovo, když:** simulovaný výpadek sítě (Playwright offline 30 s) a úmyslně vyvolaný desync se samy zotaví.

### Fáze 6: Nasazení (≈ 0,5–1 den)

-   Multi-stage Dockerfile: (1) build hry s ffmpeg a Java, (2) build serveru, (3) runtime `node:22-slim` se statikou a serverem, volume `/data` pro SQLite.
-   `docker-compose.yml` pro lokální běh i pro VPS.
-   K8s manifest (Deployment s 1 replikou, PVC pro `/data`, Service, Ingress s podporou WebSocketu).
-   Healthcheck `GET /healthz`, logy na stdout a denní záloha `/data/tvarovna.db`.
-   **Hotovo, když:** hra běží na veřejné doméně přes HTTPS a WebSocket projde přes proxy.

### Fáze 7: Playtest

-   Nejdřív 2–3 lidi na 1 hodinu a sběr bugů, pak celý tým.
-   Sledovat: desync v logu, FPS u větších továren, velikost snapshotu.

Odhad celkem: zhruba 10–13 pracovních dní s Claude Code. První hratelná verze pro 2–3 lidi je reálná po fázi 3, tedy zhruba za týden.

## 8. Hosting

| Varianta                                                                     | Pro                                                                   | Proti                                                                                | Doporučení                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| A) Vlastní K8s / VPS + Docker (např. stávající infra, 1 pod)                 | Plná kontrola, SQLite na volume, jednoduché. Stačí 1 vCPU / 1 GB RAM. | Je potřeba spravovat volume a zálohy.                                                | ✅ Doporučeno                  |
| B) Mac Mini doma/v kanceláři + Cloudflare Tunnel                             | Zdarma, bez otevírání portů. WebSocket přes Tunnel funguje.           | Závisí na jednom stroji a domácí lince.                                              | Dobré na první playtest        |
| C) Cloudflare Pages (statika) + Durable Objects (místnosti) + R2 (snapshoty) | Serverless, globální, škáluje.                                        | Přepis serveru do Workers API a limity velikosti hodnot v DO (snapshoty musí do R2). | Až když to bude chtít víc týmů |

Nároky jsou malé, protože server nesimuluje hru. Desítky světů zvládne jeden malý kontejner. Statika klienta má zhruba 20–40 MB (hlavně sprity a zvuky), takže se vyplatí Cloudflare cache před ní.

## 9. Licence a právní poznámky (není právní rada)

-   Kód je pod GPL-3.0. Když hru zpřístupníme lidem mimo firmu, musí být zdrojáky forku dostupné pod GPL, ideálně veřejný GitHub repozitář s odkazem v patičce hry. Pro interní hraní to nevadí.
-   Grafika a zvuky jsou v CE repu. Původní assety jsou v samostatném repu shapez.io-artwork. Před veřejným nebo komerčním použitím ověřit licenci assetů.
-   Nepoužívat název „shapez“ ani logo tobspr Games jako název produktu. Ponechat poděkování v kreditech.

## 10. Rizika a jak je řešíme

| Riziko                                           | Dopad               | Mitigace                                                                            |
| ------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| Nedeterminismus simulace (float, rozdíly enginů) | Klienti se rozjedou | Audit ve fázi 0, e2e test napříč prohlížeči, hashe + automatický resync             |
| Zapomenutá cesta mutace v HUD                    | Tichý desync        | Dev assert na mutace mimo `applyAction`, hash každých 5 s                           |
| Velké továrny = velký snapshot a pomalý join     | Dlouhé připojení    | Komprese, snapshot každých 60 s, inkrementální replay                               |
| Pomalý počítač hráče                             | Zaostává            | Dohánění ticků, varování, případně „spectator“ resync                               |
| Upstream CE se mění                              | Merge konflikty     | Fork na konkrétním commitu, změny držet v nových souborech, minimální zásahy do HUD |

## 11. Automatické testy multiplayeru

### Princip

Multiplayer funguje, když všichni klienti mají po stejném počtu ticků bit po bitu stejný stav. Každý test proto končí stejně: porovná hash stavu všech instancí. Když se hashe liší, test uloží celé stavy a vypíše první entitu, která se liší, včetně ticku, ve kterém k tomu došlo.

### Testovací háčky ve hře (předpoklad všeho)

Build v test režimu (`?test=1`, jen dev/test build) vystaví `window.__coop`:

-   `newWorld({ seed, startLevel })`, `loadSnapshot(data)`, `getSnapshot()`
-   `applyActions(actions[])`: stejná cesta jako akce ze sítě
-   `runTicks(n)`: simulace co nejrychleji, bez renderu, synchronně
-   `getStateHash()` a `dumpState()`: kanonický JSON pro diff
-   `setFakeDesync()`: úmyslně pokazí lokální stav (test zotavení)

Testy ovládají hru přes tohle API, ne klikáním myší. Jsou tak rychlé a stabilní. Klikání se ověřuje jen v několika smoke testech.

### Vrstvy testů

| #   | Vrstva                          | Nástroj                                       | Co ověřuje                                                                                                                                                                     | Kdy běží           |
| --- | ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 1   | Unit testy serveru              | Vitest, falešné hodiny                        | Uzavírání tahů po 100 ms, pořadí akcí, rate-limit, invite klíče, perzistence do SQLite a obnova po restartu                                                                    | každý commit (s)   |
| 2   | Protokolové testy s boty        | Vitest + Node WS klienti (bez hry)            | 10 botů posílá akce, všichni dostanou stejné tahy ve stejném pořadí. Join = snapshot + chybějící tahy, reconnect bez ztráty tahu, kontrola verze                               | každý commit (s)   |
| 3   | Determinismus: replay           | Playwright, 2+ instance hry                   | Stejný scénář akcí → shodný hash každých 1 000 ticků až do 20 000 ticků                                                                                                        | každý PR (~2 min)  |
| 4   | Determinismus napříč prohlížeči | Playwright: Chromium + Firefox + WebKit       | Totéž jako 3, ale každá instance v jiném enginu (hlídá rozdíly ve floatech a `Math.*`)                                                                                         | každý PR / nightly |
| 5   | Golden hashe                    | fixtures v repu                               | Scénář musí dát očekávaný hash uložený v repu. Odhalí nechtěnou změnu simulace po úpravách nebo merge z upstreamu                                                              | každý PR           |
| 6   | Fuzz test                       | seedovaný generátor akcí                      | Tisíce náhodných akcí (platných i neplatných: stavění přes sebe, mazání neexistujícího, paste přes hranu) ve 2 instancích → shoda hashů. Seed padlého běhu jde přehrát lokálně | nightly (30 min)   |
| 7   | E2E multiplayer                 | Playwright + skutečný server (docker compose) | Viz scénáře níže                                                                                                                                                               | každý PR (~5 min)  |
| 8   | Zátěž serveru                   | Node boti (k6 nebo vlastní skript)            | 50 světů × 10 botů, latence tahů < 20 ms, paměť stabilní                                                                                                                       | před releasem      |

### Scénáře pro replay a golden hashe (fixtures `e2e/scenarios/*.json`)

1. Základní linka: extraktor → pás → HUB, dokončení levelu 1
2. Zpracování: cutter, rotátor, stacker a lakovna v jedné lince
3. Logistika: balancery, tunely (všechny tiery), merger a splitter
4. Dráty a logika: konstantní signál, páka, filtr, logické brány
5. Blueprint: kopie velké části továrny a paste na jiné místo
6. Hromadné mazání uprostřed běžící výroby (pásy plné položek)
7. Přechod levelu během simulace a nákup upgradu ve stejném tahu
8. Freeplay: seedované cíle po levelu 27
9. Konflikty: dva hráči ve stejném tahu staví na stejné políčko (vyhrává akce, která je v tahu dřív, a druhá se ignoruje všude stejně)

### E2E multiplayer scénáře (vrstva 7)

1. **Souběžné stavění:** 3 klienti zároveň 2 minuty provádějí akce → shodný hash a stejný počet entit.
2. **Pozdní připojení:** 4. hráč se připojí po 5 minutách → dožene stav a jeho hash se shoduje s ostatními.
3. **Výpadek sítě:** `context.setOffline(true)` na 30 s, pak online → klient dožene tahy bez reloadu.
4. **Vynucený desync:** `__coop.setFakeDesync()` na jednom klientu → server to do 10 s zjistí, klient se resyncne a hash se znovu shoduje.
5. **Restart serveru:** kill kontejneru uprostřed hry → po startu se svět obnoví ze snapshotu a action logu a klienti se znovu připojí.
6. **Odchod všech:** všichni odejdou, svět se zmrazí, po návratu pokračuje od stejného ticku.
7. **Latence a jitter:** testovací proxy (toxiproxy) přidá 150 ms ± 100 ms → hra zůstane synchronní.
8. **UI smoke test:** skutečné kliknutí myší postaví pás a smaže budovu → akce projde serverem a objeví se u druhého klienta. Ověří, že HUD opravdu jde přes `dispatchAction`.

Všechny E2E testy běží s dev buildem se zapnutým guardem mutací. Jakákoli změna stavu mimo `applyAction()` test okamžitě shodí.

### Diagnostika při selhání

-   Uložit `dumpState()` všech klientů, action log a tah, kde se hash poprvé rozešel.
-   Skript `npm run desync:diff -- <artefakt>` vypíše první rozdílnou entitu a komponentu (pozice, položky na pásu, progres stroje).
-   Bisekce: replay od posledního shodného snapshotu tick po ticku až k prvnímu rozdílu.
-   Playwright trace a video u E2E testů se ukládají jako CI artefakty.

### CI

-   Každý PR: vrstvy 1–3, 5 a 7 (jen Chromium), zhruba 10 minut.
-   Nightly: vrstva 4 (všechny 3 enginy), vrstva 6 (fuzz 30 min) a dlouhý soak test (2 klienti, 1 h hry, hash každých 5 s).
-   Spouští se v oficiálním Playwright Docker image. Běží na GitHub Actions i Bitbucket Pipelines.
-   Merge je blokovaný, pokud selže determinismus nebo E2E.

### Zařazení do fází

-   Fáze 2: háčky `__coop`, vrstvy 3, 5 a první replay scénáře.
-   Fáze 3: vrstvy 1, 2 a E2E scénáře 1–2.
-   Fáze 5: E2E scénáře 3–7, fuzz a nightly pipeline.
-   Fáze 6: zátěžový test.

## 12. Instrukce pro Claude Code

-   Pracuj fázi po fázi a na začátku každé fáze si udělej task list.
-   Po každé fázi: testy, commit s popisem a krátké shrnutí, co je hotovo a co zbývá.
-   Nové věci piš v TypeScriptu. Existující JS kód nepřepisuj, pokud to není nutné.
-   Zásahy do původního kódu hry drž minimální a označ je komentářem `// COOP:`.
-   Než začneš fázi 2, ukaž mi výsledek auditu determinismu a navržené opravy.
-   Nejasná rozhodnutí v game designu mi předlož jako otázku, nevymýšlej je.
