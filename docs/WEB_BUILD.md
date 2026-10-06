# Webový build

Hra běží v Electronu i v běžném prohlížeči. Webová verze se pozná podle toho, že
chybí `window.ipcRenderer` z Electron preloadu. V tom případě
`src/js/platform/web/install.ts` nainstaluje `WebIpcRenderer`, který obslouží
stejné IPC kanály jako Electron main process:

| Kanál                                        | Electron                      | Web                                                               |
| -------------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `fs-job` (`read`, `write`, `delete`, `list`) | soubory v `userData/saves`    | IndexedDB `tvarovna` → store `files`, klíč `<storageId>/<soubor>` |
| `fs-job` (`open-external`)                   | nativní dialog                | `<input type=file>`                                               |
| `fs-job` (`save-external`)                   | nativní dialog                | stažení přes Blob                                                 |
| `get-mods`                                   | načte mody z disku            | vždy `[]` (mody na webu nejsou)                                   |
| `set-fullscreen`                             | `BrowserWindow.setFullScreen` | Fullscreen API (jen po akci uživatele)                            |

Díky tomu `Storage`, `ModLoader` i zbytek hry zůstávají beze změny. Upravené
soubory původní hry jsou označené `// COOP:`:

-   `src/js/main.js`: import `platform/web/install` před bootem
-   `src/js/application.js`: na webu se použije `PlatformWrapperImplWeb`
-   `src/css/main.scss` + `src/css/platform_web.scss`: skryje tlačítka Exit a Mody
-   `gulp/build_variants.js`, `gulp/tasks.js`: varianta `web` a úloha `package.web.static`

## Příkazy

```sh
npm ci                 # stáhne i texture packer (potřebuje Javu) a připraví prostředí
npm run build:web      # produkční build → build_output/web (statický adresář)
npm run serve:web      # dev server s live reloadem na http://localhost:3005
```

`build_output/web` stačí servírovat libovolným statickým serverem, například
`python3 -m http.server -d build_output/web 8080`.

V Dockeru (stávající builder image):

```sh
docker build -f Dockerfile.builder -t tvarovna-builder .
docker run --rm -v "$PWD/out:/output" tvarovna-builder package.web.static
# výsledek: out/web
```

## Ověření

-   Chromium (Playwright 1.56, headless): hlavní menu → nová hra → uložení → reload → save je
    v seznamu, bez chyb v konzoli. HTML má třídu `p-web`.
-   Firefox a Safari/WebKit zatím ověřené nejsou, v tomto prostředí nejsou
    nainstalované. Kód používá jen standardní API (IndexedDB,
    `Promise.withResolvers` → Safari 17.4+, Fullscreen API).

## Známá omezení

-   Puzzle DLC volá online API puzzle serveru tobspr. Pro co-op ho ve fázi 4 skryjeme.
-   Odkaz na Steam a sociální sítě v menu zatím zůstává (řeší se ve fázi 4 s vlastní úvodní stránkou).
