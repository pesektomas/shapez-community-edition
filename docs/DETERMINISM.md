# Audit determinismu (fáze 0)

Cíl: všichni klienti musí ze stejného snapshotu a stejné sekvence akcí dojít bit po
bitu ke stejnému stavu, a to i napříč enginy (V8, SpiderMonkey, JavaScriptCore).
Cesty jsou relativní k `src/js/`. Stav k commitu `a3fdbf4` (upstream CE).

## TL;DR

Jádro simulace je na lockstep v dobrém stavu. Alea RNG, generování mapy, uid entit,
pořadí iterace systémů i aritmetika pásů a strojů jsou deterministické. Problémy
jsou ve čtyřech oblastech:

1. **Řízení času**: tickrate z nastavení, zahazování ticků a lokální pauza.
2. **Statistiky produkce**: počítají se po framech, ne po tickách, a rozhodují o splnění levelu.
3. **Mutace z HUD**: stavění, mazání, obchod a signály mimo hranici ticku, některé asynchronně z dialogu.
4. **Savegame není bezztrátový**: floaty se ořezávají na 4 desetinná místa a obsah strojů se neukládá.
   Pro late join a resync je to zásadní.

## A. Opravy nutné pro lockstep (high)

| #   | Místo                                                  | Problém                                                                                                                                                                                                                            | Navržená oprava                                                                                                                                                                                  |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `game/dynamic_tickrate.js:26-31`                       | Tickrate se bere z nastavení `refreshRate` (30–240 Hz). Všechny systémy násobí `deltaSeconds`, takže při jiném nastavení vznikne jiný svět.                                                                                        | `CoopGameMode.getFixedTickrate()` → 60, stejně jako puzzle mód. Bez zásahu do původního kódu.                                                                                                    |
| A2  | `game/game_time.js:60-108`                             | Rozpočet ticků se počítá z dt `requestAnimationFrame`, `maxLogicSteps` zahazuje přebytek, `hud.shouldPauseGame()` (menu, tutoriál) budget vynuluje.                                                                                | Nový `lockstep.ts` řídí ticky sám: tick N se spustí, až když je známý tah, do kterého patří. Ticky se nikdy nezahazují ani nepauzují. V co-op režimu se `performTicks` obejde (`// COOP:` hook). |
| A3  | `game/core.js:242`, `game/production_analytics.js:128` | `productionAnalytics.update()` běží jednou za frame. Hranice slice tedy závisí na počtu ticků ve framu. `hubGoals.getCurrentGoalDelivered()` z nich počítá throughput cíle (level „throughputOnly“ a **všechny freeplay levely**). | V co-op volat `update()` uvnitř `updateLogic` (po každém ticku). Délku slice vázat na celočíselný čítač ticků.                                                                                   |
| A4  | `core/config.ts:32`                                    | `analyticsSliceDurationSeconds = G_IS_DEV ? 1 : 10`, takže se dev a prod build liší v logice.                                                                                                                                      | V co-op konstanta 10 bez ohledu na build. Navíc kontrola verze buildu při připojení (viz A8).                                                                                                    |
| A5  | `game/systems/underground_belt.js:54`                  | Nastavení `enableTunnelSmartplace` při položení tunelu maže pásy mezi tunely.                                                                                                                                                      | Hodnotu ponese akce `placeBuilding` (flag hráče, který staví). `onEntityManuallyPlaced` v co-op čte flag z akce.                                                                                 |
| A6  | HUD (viz D)                                            | Stav se mění přímo z HUD, někdy asynchronně (callback dialogu konstantního signálu).                                                                                                                                               | Vrstva akcí `dispatchAction` → `applyAction` na hranici tahu (fáze 2), plus dev guard.                                                                                                           |
| A7  | `game/core.js:159`                                     | `map.seed = randomInt(...)` (Math.random).                                                                                                                                                                                         | Seed volí server při `POST /api/worlds` a je součástí snapshotu.                                                                                                                                 |
| A8  | `globalConfig.debug.*`, `G_IS_DEV`, mody               | Debug flagy (`instantBelts`, `instantMiners`, `upgradesNoCost`, `rewardsInstant` …) a registry modů mění logiku.                                                                                                                   | Klient posílá v `hello` `clientVersion` = hash buildu, v co-op jsou debug flagy vypnuté a mody zakázané (na webu stejně nejsou).                                                                 |

## B. Snapshot ≠ běžící hra (high, nutné pro join a resync)

Plán počítá s tím, že snapshot = savegame. Audit ukázal, že **save → load → pokračování
nedá stejný stav jako pokračování bez save**:

| Místo                                                       | Co se ztratí nebo změní                                                                                                                             | Sev  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `savegame/serialization_data_types.js:442` (`round4Digits`) | **Každý** `types.float`/`ufloat` se ořízne na 1e-4: pozice položek na pásech, progres ejectorů, filtrů a tunelů, `lastMiningTime`, `timeSeconds`.   | high |
| `game/components/item_processor.js:46`                      | Ukládá se jen `nextOutputSlot`. `inputSlots`, `ongoingCharges`, `queuedEjects` a `bonusTime` se ztratí, takže položky ve strojích po načtení zmizí. | high |
| `game/production_analytics.js`                              | `history` a `lastAnalyticsSlice` se neukládají. S A3 to ovlivní throughput cíle.                                                                    | high |
| `game/belt_path.js:185-192`                                 | `numCompressedItemsAfterFirstItem` se po načtení vynuluje. Mění větev `fixupProgress`, takže se rozejde progres položek.                            | med  |
| `game/belt_path.js:1117`                                    | `totalLength` se za běhu počítá inkrementálně (`+= 1` / `0.78`), po načtení se sečte znovu. Jiné pořadí sčítání floatů může dát rozdíl 1 ulp.       | med  |
| `game/systems/miner.js:134`                                 | `cachedChainedMiner` se neukládá a první eject po načtení jde jinam.                                                                                | med  |
| `game/components/belt_reader.js:28-40`                      | `lastItemTimes` a throughput se neukládají. Pin 0 jde do drátové logiky.                                                                            | med  |
| `game/systems/wire.js:139-180`                              | Sítě se staví až v prvním `update()` drátů. Systémy, které běží dřív (filter, painterQuad), vidí v prvním ticku `linkedNetwork=null`.               | med  |

**Návrh:** snapshot pro co-op bude savegame s těmito úpravami:

1. V co-op režimu serializovat floaty bezztrátově. `TypeNumber` přeskočí `round4Digits`,
   když je aktivní co-op snapshot. Msgpack i JSON přenesou double přesně.
2. Doplnit chybějící pole do schémat (`ItemProcessor`, `ProductionAnalytics`, `BeltPath`,
   `BeltReader`, `cachedChainedMiner`) a přepočet drátových sítí v `postLoadHook`.
   Rozšíření schématu je zpětně kompatibilní, protože starší savegame jen nemá nová pole.
3. **Nový test (vrstva 3b):** `stav(N + K)` musí být roven `stav(load(save(N)) + K)` pro
   všechny scénáře. Tím se odhalí každé další neukládané pole.

Alternativa bez zásahu do serializace je join přes replay celé historie akcí od
začátku světa. Pro dlouhé světy je ale nepoužitelná (hodiny simulace), proto ji
nedoporučuji.

## C. Nízká priorita a pojistky

| Místo                                                            | Problém                                                                                                                     | Oprava                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game/blueprint.ts:65`                                           | Cena blueprintu `4 * Math.pow(n, 1.1)`. `pow` nemá v ECMAScriptu garantované zaokrouhlení, takže se může lišit mezi enginy. | Předpočítaná celočíselná tabulka cen (stejné hodnoty jako dnes).                                                                                           |
| `game/map_chunk.js:284`                                          | `Vector.length()` = `Math.hypot` při generování mapy. Vstupy jsou poloceločíselné, takže riziko je teoretické.              | Nahradit za `Math.sqrt(x*x + y*y)`, které je IEEE přesné.                                                                                                  |
| `game/systems/item_acceptor.js:17-35`                            | V logickém ticku přeskakuje práci podle `simplifiedBelts` a zoomu. Mění jen animace, které logika nečte.                    | Vyloučit z hashe stavu, případně přesunout do draw.                                                                                                        |
| `game/components/goal_acceptor.js`, `game/components/storage.js` | Render-only pole (`displayPercentage`, `overlayOpacity`) se mění v update a draw.                                           | Vyloučit z hashe stavu.                                                                                                                                    |
| `core/rng.ts:52`                                                 | Seed má default `Math.random()` (dnes nikdo nevolá bez seedu).                                                              | Lint pravidlo: v `game/systems`, `game/components` a `logic.js` zakázat `Math.random`, `Date.now`, `performance.now` a `Math.sin/cos/pow/exp/atan2/hypot`. |
| `game/game_time.js:106`                                          | `timeSeconds += 1/rate` je deterministické, ale ukládá se ořezaně (viz B).                                                  | Bezztrátová serializace (B1). Volitelně celočíselný čítač ticků.                                                                                           |

## D. Místa, kde HUD mutuje stav (budou akce)

| Akce                | Místo                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeBuilding`     | `hud/parts/building_placer_logic.js:452` (`logic.tryPlaceBuilding`). Akce nese výsledné `origin`, `rotation`, `rotationVariant`, `variant` a `tunnelSmartplace`. |
| `deleteBuildings`   | `building_placer_logic.js:333, :787`, `mass_selector.js:106, :192`                                                                                               |
| `clearBelts`        | `mass_selector.js:151`. Pozor: maže celou belt path, ne jen vybrané pásy.                                                                                        |
| `pasteBlueprint`    | `game/blueprint.ts:168`. Pořadí entit v blueprintu určuje nové uid, takže akce musí nést uspořádaný seznam entit a rotaci.                                       |
| `unlockUpgrade`     | `hud/parts/shop.js:245`                                                                                                                                          |
| `setConstantSignal` | `hud/parts/constant_signal_edit.js:143-177`. Asynchronní callback dialogu, při zrušení entitu maže.                                                              |
| `toggleLever`       | `hud/parts/lever_toggle.js:22`                                                                                                                                   |
| (dev)               | `hub_goals.js:114`: klávesa „p“ v dev buildu dokončí level. V co-op vypnout.                                                                                     |
| (mimo co-op)        | sandbox a puzzle editory (`sandbox_controller.js`, `puzzle_*`). V co-op HUD se nenačtou.                                                                         |

## E. Ověřeno jako bezpečné

-   **Alea RNG** (`core/rng.ts`) používá jen `+ - * >>> |0`. JS zakazuje FMA, takže je deterministická napříč enginy. Freeplay tvary (`hub_goals.js:386`) jsou seedované.
-   **Uid entit:** čítač `nextUid` od 10000 se serializuje, entity si uid při načtení zachovají a jiné generování neexistuje.
-   **Pořadí iterace:** `EntityManager` Map a Set mají vkládací pořadí, které odpovídá vzestupným uid. `allEntities` systémů se řadí podle uid. Pořadí `beltPaths` je deterministické při stejné sekvenci akcí. Pořadí systémů je pevné.
-   **Mapa:** chunky se generují líně podle kamery, ale každý chunk má vlastní seed `x|y|seed` a logika `chunksById` neiteruje.
-   **`realtimeNow`, `performance.now` a `Date.now`** se používají jen pro render, statistiky FPS a autosave timer.
-   **Aritmetika** pásů, ejectorů, procesorů, minerů a filtrů používá jen `+ - * /`, min, max a porovnání.
-   **Cache** (`ShapeDefinitionManager`, stale-area detektory) jsou čisté funkce, nebo se invalidují signály a přepočítají na začátku updatu systému.
-   **Drátové sítě:** výsledná hodnota nezávisí na pořadí (konflikt = dvě různé hodnoty).
-   **Sort** v simulaci používá komparátor podle uid, takže je totální.

## F. Nalezené upstream bugy (deterministické, zatím neopravujeme)

-   `game/systems/filter.js`: `shift()` uvnitř indexové smyčky, takže se v daném ticku přeskočí další položka.
-   `game/hub_goals.js:389`: `computeFreeplayShape` používá `this.level` místo parametru `level`.
-   `game/map_chunk.js:105`: `y <= mapChunkSize` může zapsat řádek mimo chunk.
-   `game/entity_manager.ts:110`: `removeDynamicComponent` volá `getId()` na konstruktoru konstruktoru.

## Navržené pořadí oprav ve fázi 2

1. `CoopGameMode`: fixní tickrate 60, vypnutá pauza a debug flagy, slice analytiky 10 s (A1, A4, A8).
2. `lockstep.ts`: vlastní řízení ticků a `productionAnalytics.update()` po ticku (A2, A3).
3. Vrstva akcí a dev guard mutací (A5, A6, D).
4. `state_hash.ts`, bez render-only polí (C).
5. Bezztrátový snapshot a doplnění schémat (B), test „save/load = pokračování“.
6. `Math.pow` v blueprint ceně a `hypot` v `map_chunk` (C).
7. Replay testy v Playwrightu (vrstvy 3 a 5).

## Stav oprav (fáze 2–5)

| Nález                                 | Stav | Řešení                                                                                      |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| A1 tickrate z nastavení               | ✅   | `CoopGameMode.getFixedTickrate()` = 60                                                      |
| A2 rozpočet ticků, pauza              | ✅   | `CoopSession.performFrame` místo `GameTime.performTicks`, ticky jen podle tahů              |
| A3 analytika po framech               | ✅   | `productionAnalytics.update()` po každém ticku                                              |
| A4 délka slice dev/prod               | ⚠️   | Neřešeno konstantou: kontrola verze buildu zajistí stejný build u všech hráčů               |
| A5 tunnel smartplace                  | ✅   | příznak `tunnelSmartplace` v akci `placeBuilding`                                           |
| A6 mutace z HUD                       | ✅   | `net/hud_actions.ts`, dev guard na přidání a mazání entit mimo akce                         |
| A7 seed mapy                          | ✅   | seed volí server, `GameMode.getInitialSeed()`                                               |
| A8 debug flagy, mody                  | ✅   | kontrola verze (`protokol/commit`), mody na webu nejsou                                     |
| B snapshot ≠ běžící hra               | ✅   | bezztrátové floaty + `snapshot.ts` extras, ověřeno testem „snapshot restore“ ve 9 scénářích |
| C1 `Math.pow` v ceně blueprintu       | ✅   | cena jde v akci `pasteBlueprint`                                                            |
| C2 `Math.hypot` v generování mapy     | ✅   | `Math.sqrt(x*x + y*y)`                                                                      |
| C3–C5 render-only pole, `Math.random` | ✅   | mimo hash (kamera, waypointy, pinned, realtime), RNG se v simulaci bez seedu nevolá         |
| extra update po načtení (ingame.js)   | ✅   | v co-op se `stage5FirstUpdate` nesimuluje, jinak by obnovený svět byl o tick napřed         |
