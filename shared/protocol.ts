/**
 * Network protocol shared between the game client and the co-op server.
 *
 * NOTE: This file is imported by the server, which runs TypeScript through
 * Node's type stripping. Only erasable syntax is allowed here (no enums,
 * namespaces or parameter properties).
 */

/** Increment whenever the protocol or the simulation changes incompatibly */
export const PROTOCOL_VERSION = 1;

/** Simulation ticks per second, fixed for every co-op world */
export const TICK_RATE = 60;

/** Real-time length of one lockstep turn */
export const TURN_MS = 100;

/** Simulation ticks per turn */
export const TICKS_PER_TURN = (TICK_RATE * TURN_MS) / 1000;

/** Clients report a state hash every N turns */
export const HASH_INTERVAL_TURNS = 50;

/** The leader uploads a snapshot every N turns */
export const SNAPSHOT_INTERVAL_TURNS = 600;

export const MAX_PLAYERS_PER_WORLD = 10;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ACTION_BYTES = 512 * 1024;
export const MAX_CHAT_LENGTH = 300;
export const MAX_NAME_LENGTH = 24;

export type StartMode = "fresh" | "quick" | "freeplay";

/** Level at which a world starts, per start mode */
export const START_LEVELS: Record<StartMode, number> = {
    fresh: 1,
    quick: 7,
    freeplay: 27,
};

export interface WorldParams {
    seed: number;
    startLevel: number;
}

export interface WorldMeta {
    id: string;
    name: string;
    params: WorldParams;
    createdAt: number;
}

/////////////////// ACTIONS ///////////////////

export interface BlueprintEntityData {
    /** Building code, see building_codes.js */
    code: number;
    x: number;
    y: number;
    rotation: number;
    originalRotation: number;
    /** Serialized constant signal, if any */
    signal?: unknown;
    /** Lever state, if any */
    toggled?: boolean;
}

export interface ActionPayloads {
    placeBuilding: {
        x: number;
        y: number;
        building: string;
        variant: string;
        /** Base rotation the player had selected, the effective rotation is computed on apply */
        rotation: number;
        /** Whether to remove belts between tunnels (player setting) */
        tunnelSmartplace: boolean;
        /** Whether the placing player wants to edit the constant signal right away */
        editSignal?: boolean;
    };
    /** Re-creates buildings exactly as they were, used by undo */
    restoreBuildings: {
        entities: BlueprintEntityData[];
    };
    deleteBuildings: {
        uids: number[];
        /** Set when sent by undo, so it does not create an undo step itself */
        undo?: boolean;
    };
    clearBelts: {
        uids: number[];
    };
    pasteBlueprint: {
        x: number;
        y: number;
        entities: BlueprintEntityData[];
        free: boolean;
        /**
         * Cost as computed by the sender. The formula uses Math.pow which may
         * round differently across engines, so everyone uses this value.
         */
        cost: number;
    };
    unlockUpgrade: {
        upgradeId: string;
    };
    setConstantSignal: {
        uid: number;
        signal: unknown;
    };
    toggleLever: {
        uid: number;
    };
    addWaypoint: {
        label: string;
        x: number;
        y: number;
        zoomLevel: number;
        layer: string;
    };
    removeWaypoint: {
        label: string;
        x: number;
        y: number;
    };
    renameWaypoint: {
        oldLabel: string;
        x: number;
        y: number;
        label: string;
    };
}

export type ActionType = keyof ActionPayloads;

export const ACTION_TYPES: readonly ActionType[] = [
    "placeBuilding",
    "restoreBuildings",
    "deleteBuildings",
    "clearBelts",
    "pasteBlueprint",
    "unlockUpgrade",
    "setConstantSignal",
    "toggleLever",
    "addWaypoint",
    "removeWaypoint",
    "renameWaypoint",
];

export type Action<T extends ActionType = ActionType> = {
    [K in T]: { type: K; payload: ActionPayloads[K] };
}[T];

/** An action as ordered by the server inside a turn */
export type TurnAction = Action & {
    playerId: number;
    clientSeq: number;
};

export interface Turn {
    n: number;
    actions: TurnAction[];
}

/////////////////// MESSAGES ///////////////////

export interface PlayerInfo {
    id: number;
    name: string;
    color: string;
    online: boolean;
}

export interface SnapshotPayload {
    /** Turn whose actions have NOT been applied yet */
    turn: number;
    /** msgpack-encoded, deflated snapshot */
    data: Uint8Array;
    hash?: string;
}

export type ClientMessage =
    | {
          t: "hello";
          worldId: string;
          inviteKey: string;
          name: string;
          clientVersion: string;
          /** Set when reconnecting, the server then only sends missing turns */
          resumeFromTurn?: number;
          playerToken?: string;
          password?: string;
      }
    | ({ t: "action"; clientSeq: number } & Action)
    | { t: "hash"; turn: number; hash: string }
    | { t: "snapshot"; turn: number; data: Uint8Array; hash: string }
    | { t: "cursor"; x: number; y: number; layer: string }
    | { t: "chat"; text: string }
    | { t: "ping"; time: number };

export type ServerMessage =
    | {
          t: "welcome";
          playerId: number;
          playerToken: string;
          color: string;
          world: WorldMeta;
          /** null for a fresh world, the client then creates it from the world params */
          snapshot: SnapshotPayload | null;
          /** Turns from the snapshot (or from 0) up to now */
          turnsSince: Turn[];
          players: PlayerInfo[];
          resumed: boolean;
      }
    | ({ t: "turn" } & Turn)
    | { t: "players"; list: PlayerInfo[] }
    | { t: "cursor"; playerId: number; x: number; y: number; layer: string }
    | { t: "chat"; playerId: number; text: string; time: number }
    | { t: "requestSnapshot"; turn: number }
    | { t: "resync"; snapshot: SnapshotPayload; turnsSince: Turn[] }
    | {
          t: "notice";
          kind: "playerJoined" | "playerLeft" | "desync" | "info";
          playerId?: number;
          text?: string;
      }
    | { t: "pong"; time: number; serverTurn: number }
    | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode =
    | "bad_request"
    | "world_not_found"
    | "invalid_invite"
    | "invalid_password"
    | "version_mismatch"
    | "world_full"
    | "rate_limited"
    | "message_too_large"
    | "internal";

/////////////////// HELPERS ///////////////////

export function isActionType(value: unknown): value is ActionType {
    return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}

export const PLAYER_COLORS = [
    "#e74c3c",
    "#3498db",
    "#2ecc71",
    "#f39c12",
    "#9b59b6",
    "#1abc9c",
    "#e67e22",
    "#e84393",
    "#00b894",
    "#6c5ce7",
];
