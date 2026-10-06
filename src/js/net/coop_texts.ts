/**
 * Texts of the co-op UI. The team plays in Czech, everybody else gets English.
 */
const cs = {
    title: "Tvarovna",
    subtitle: "Společná továrna na tvary v prohlížeči",
    nickname: "Přezdívka",
    nicknamePlaceholder: "Jak ti mají říkat?",
    password: "Heslo serveru",
    join: "Připojit se",
    joinWorld: "Připojit se ke světu",
    newWorld: "Nový svět",
    worldName: "Název světu",
    worldNamePlaceholder: "Naše továrna",
    create: "Založit svět",
    myWorlds: "Moje světy",
    noWorlds: "Zatím žádné. Založ svět nebo otevři pozvánku od kolegy.",
    lastPlayed: "naposledy",
    joinByLink: "Mám pozvánku",
    linkPlaceholder: "Vlož odkaz https://…/w/…",
    singleplayer: "Hrát sám (offline)",
    credits:
        'Založeno na <a href="https://github.com/tobspr-games/shapez-community-edition" target="_blank" rel="noopener">shapez Community Edition</a> (GPL-3.0). Díky, tobspr Games!',
    source: "Zdrojový kód",
    startModes: {
        fresh: [
            "Od začátku (level 1)",
            "Doporučeno pro první hru a nováčky. Prvních pár levelů je tutoriál.",
        ],
        quick: [
            "Rychlý start (level 7)",
            "Pro ty, kdo shapez znají. Odemčené balancery, rotátory, tunely a lakovna.",
        ],
        freeplay: ["Freeplay (level 27+)", "Všechno odemčené, náhodné cíle. Na dlouhé hraní."],
    },
    status: {
        connecting: "Připojuji se…",
        loading: "Načítám svět…",
        playing: "Ve hře",
        reconnecting: "Spojení ztraceno, připojuji znovu…",
        closed: "Odpojeno",
        error: "Chyba",
    },
    errors: {
        invalid_invite: "Pozvánka je neplatná. Zkontroluj odkaz.",
        world_not_found: "Tenhle svět neexistuje.",
        invalid_password: "Špatné heslo serveru.",
        version_mismatch: "Hra se mezitím aktualizovala. Obnov stránku (F5).",
        world_full: "Svět je plný.",
        load_failed: "Svět se nepodařilo načíst.",
        create_failed: "Svět se nepodařilo založit.",
        no_server: "Server není dostupný.",
        name_required: "Zadej přezdívku.",
        default: "Něco se pokazilo.",
    },
    reload: "Obnovit stránku",
    back: "Zpět",
    copyInvite: "Zkopírovat pozvánku",
    inviteCopied: "Pozvánka zkopírována",
    players: "Hráči",
    chatPlaceholder: "Napiš zprávu a stiskni Enter",
    playerJoined: "<name> se připojil(a)",
    playerLeft: "<name> odešel/odešla",
    levelCompleted: "Level <level> splněn! Odměna pro všechny.",
    upgradeBought: "<name> koupil(a) <upgrade> <tier>",
    waypointAdded: "<name> přidal(a) značku <label>",
    desync: "Svět se rozešel s ostatními, načítám znovu…",
    lagging: "Nestíháš ostatní, doháním…",
    disconnected: "Spojení ztraceno, připojuji znovu…",
};

type Texts = typeof cs;

const en: Texts = {
    title: "Tvarovna",
    subtitle: "A shared shape factory in your browser",
    nickname: "Nickname",
    nicknamePlaceholder: "What should we call you?",
    password: "Server password",
    join: "Join",
    joinWorld: "Join the world",
    newWorld: "New world",
    worldName: "World name",
    worldNamePlaceholder: "Our factory",
    create: "Create world",
    myWorlds: "My worlds",
    noWorlds: "None yet. Create a world or open an invite link.",
    lastPlayed: "last played",
    joinByLink: "I have an invite",
    linkPlaceholder: "Paste a link https://…/w/…",
    singleplayer: "Play alone (offline)",
    credits:
        'Based on <a href="https://github.com/tobspr-games/shapez-community-edition" target="_blank" rel="noopener">shapez Community Edition</a> (GPL-3.0). Thanks, tobspr Games!',
    source: "Source code",
    startModes: {
        fresh: ["From scratch (level 1)", "Recommended for the first game. The first levels are a tutorial."],
        quick: [
            "Quick start (level 7)",
            "For shapez veterans. Balancers, rotators, tunnels and painters unlocked.",
        ],
        freeplay: ["Freeplay (level 27+)", "Everything unlocked, random goals. For long sessions."],
    },
    status: {
        connecting: "Connecting…",
        loading: "Loading the world…",
        playing: "Playing",
        reconnecting: "Connection lost, reconnecting…",
        closed: "Disconnected",
        error: "Error",
    },
    errors: {
        invalid_invite: "The invite is invalid. Check the link.",
        world_not_found: "This world does not exist.",
        invalid_password: "Wrong server password.",
        version_mismatch: "The game was updated. Please reload the page (F5).",
        world_full: "The world is full.",
        load_failed: "The world could not be loaded.",
        create_failed: "The world could not be created.",
        no_server: "The server is not reachable.",
        name_required: "Please enter a nickname.",
        default: "Something went wrong.",
    },
    reload: "Reload",
    back: "Back",
    copyInvite: "Copy invite link",
    inviteCopied: "Invite link copied",
    players: "Players",
    chatPlaceholder: "Type a message and press Enter",
    playerJoined: "<name> joined",
    playerLeft: "<name> left",
    levelCompleted: "Level <level> completed! Rewards for everyone.",
    upgradeBought: "<name> bought <upgrade> <tier>",
    waypointAdded: "<name> added the marker <label>",
    desync: "Your world diverged, reloading…",
    lagging: "You are behind the others, catching up…",
    disconnected: "Connection lost, reconnecting…",
};

let current: Texts = cs;

export function setCoopLanguage(language: string) {
    current = language && language.startsWith("cs") ? cs : en;
}

export function coopText(): Texts {
    return current;
}

export function fill(template: string, values: Record<string, string | number>) {
    return template.replace(/<(\w+)>/g, (match, key: string) =>
        key in values ? escapeHtml(String(values[key])) : match
    );
}

export function escapeHtml(text: string) {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
