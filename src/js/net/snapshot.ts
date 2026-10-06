import type { BaseItem } from "../game/base_item";
import type { EjectorCharge, EjectorItemToEject } from "../game/components/item_processor";
import type { Entity } from "../game/entity";
import { itemResolverSingleton, typeItemSingleton } from "../game/item_resolver";
import type { GameRoot } from "../game/root";
import { SavegameSerializer } from "../savegame/savegame_serializer";
import type { SerializedGame } from "../savegame/savegame_typedefs";
import type { WireNetwork } from "../game/systems/wire";
import { withLosslessSerialization } from "../savegame/serialization_options";

/**
 * A co-op snapshot is the regular savegame dump (serialized without float
 * rounding) plus the runtime state the savegame does not contain. Restoring
 * a snapshot must produce exactly the state the game had when it was taken,
 * otherwise late joiners immediately desync.
 */
export interface CoopSnapshot {
    version: 1;
    dump: SerializedGame;
    extras: SnapshotExtras;
}

type SerializedItem = unknown;

interface SnapshotExtras {
    analytics: {
        history: Record<string, Array<Record<string, number>>>;
        lastAnalyticsSlice: number;
    };
    beltPaths: Array<{ totalLength: number; numCompressedItemsAfterFirstItem: number }>;
    processors: Array<
        [
            number,
            {
                inputSlots: Array<[number, SerializedItem]>;
                inputCount: number;
                bonusTime: number;
                ongoingCharges: Array<{ remainingTime: number; items: SerializedEjectItem[] }>;
                queuedEjects: SerializedEjectItem[];
            },
        ]
    >;
    beltReaders: Array<
        [number, { lastItemTimes: number[]; lastThroughput: number; lastThroughputComputation: number }]
    >;
    minerNeedsRecompute: boolean;
    /** uid of the chained miner, false if there is none, null if not computed yet */
    chainedMiners: Array<[number, number | false | null]>;
    wireNeedsRecompute: boolean;
    wireNetworks: Array<{ key: number; value: SerializedItem | null; conflict: boolean }>;
}

interface SerializedEjectItem {
    item: SerializedItem;
    requiredSlot?: number;
    preferredSlot?: number;
}

function serializeItem(item: BaseItem | null): SerializedItem | null {
    return item ? typeItemSingleton.serialize(item) : null;
}

function deserializeItem(root: GameRoot, data: unknown): BaseItem | null {
    return data ? itemResolverSingleton(root, data as { $: string; data: unknown }) : null;
}

function serializeEjectItem(entry: EjectorItemToEject): SerializedEjectItem {
    const result: SerializedEjectItem = { item: serializeItem(entry.item) };
    if (entry.requiredSlot !== undefined) {
        result.requiredSlot = entry.requiredSlot;
    }
    if (entry.preferredSlot !== undefined) {
        result.preferredSlot = entry.preferredSlot;
    }
    return result;
}

function deserializeEjectItem(root: GameRoot, entry: SerializedEjectItem): EjectorItemToEject {
    const result: EjectorItemToEject = { item: deserializeItem(root, entry.item) };
    if (entry.requiredSlot !== undefined) {
        result.requiredSlot = entry.requiredSlot;
    }
    if (entry.preferredSlot !== undefined) {
        result.preferredSlot = entry.preferredSlot;
    }
    return result;
}

/**
 * Returns a stable identifier of a wire network: the lowest uid of any entity in it
 */
function getNetworkKey(network: WireNetwork): number {
    let key = Number.MAX_SAFE_INTEGER;
    for (const wire of network.wires) {
        key = Math.min(key, wire.uid);
    }
    for (const tunnel of network.tunnels) {
        key = Math.min(key, tunnel.uid);
    }
    for (const slot of network.allSlots) {
        key = Math.min(key, slot.entity.uid);
    }
    return key;
}

function serializeExtras(root: GameRoot): SnapshotExtras {
    const systems = root.systemMgr.systems;

    const processors: SnapshotExtras["processors"] = [];
    const beltReaders: SnapshotExtras["beltReaders"] = [];
    const chainedMiners: SnapshotExtras["chainedMiners"] = [];

    for (const entity of root.entityMgr.entities.values()) {
        if (entity.queuedForDestroy || entity.destroyed) {
            continue;
        }

        const processor = entity.components.ItemProcessor;
        if (processor) {
            processors.push([
                entity.uid,
                {
                    inputSlots: Array.from(processor.inputSlots.entries()).map(([slot, item]) => [
                        slot,
                        serializeItem(item),
                    ]),
                    inputCount: processor.inputCount,
                    bonusTime: processor.bonusTime,
                    ongoingCharges: processor.ongoingCharges.map((charge: EjectorCharge) => ({
                        remainingTime: charge.remainingTime,
                        items: charge.items.map(serializeEjectItem),
                    })),
                    queuedEjects: processor.queuedEjects.map(serializeEjectItem),
                },
            ]);
        }

        const reader = entity.components.BeltReader;
        if (reader) {
            beltReaders.push([
                entity.uid,
                {
                    lastItemTimes: reader.lastItemTimes.slice(),
                    lastThroughput: reader.lastThroughput,
                    lastThroughputComputation: reader.lastThroughputComputation,
                },
            ]);
        }

        const miner = entity.components.Miner;
        if (miner && miner.chainable) {
            const cached = miner.cachedChainedMiner as Entity | false | null;
            chainedMiners.push([entity.uid, cached ? cached.uid : (cached as false | null)]);
        }
    }

    const analytics = root.productionAnalytics;

    return {
        analytics: {
            history: structuredClone(analytics.history),
            lastAnalyticsSlice: analytics.lastAnalyticsSlice,
        },
        beltPaths: systems.belt.beltPaths.map(path => ({
            totalLength: path.totalLength,
            numCompressedItemsAfterFirstItem: path.numCompressedItemsAfterFirstItem,
        })),
        processors,
        beltReaders,
        minerNeedsRecompute: systems.miner.needsRecompute,
        chainedMiners,
        wireNeedsRecompute: systems.wire.needsRecompute,
        wireNetworks: systems.wire.needsRecompute
            ? []
            : systems.wire.networks.map(network => ({
                  key: getNetworkKey(network),
                  value: serializeItem(network.currentValue),
                  conflict: network.valueConflict,
              })),
    };
}

/**
 * Creates a snapshot of the current game state. Must be called between ticks.
 */
export function createSnapshot(root: GameRoot): CoopSnapshot {
    return withLosslessSerialization(() => {
        const serializer = new SavegameSerializer();
        const dump = serializer.generateDumpFromGameRoot(root, false);
        assert(dump, "Failed to create game dump");
        return {
            version: 1,
            dump,
            extras: serializeExtras(root),
        };
    });
}

/**
 * Restores the runtime state which is not part of the savegame. Must be
 * called after the dump was deserialized and the post load hook ran.
 */
export function applySnapshotExtras(root: GameRoot, extras: SnapshotExtras) {
    const systems = root.systemMgr.systems;

    // Analytics
    root.productionAnalytics.history = structuredClone(extras.analytics.history);
    root.productionAnalytics.lastAnalyticsSlice = extras.analytics.lastAnalyticsSlice;

    // Belt paths are deserialized in the same order as they were serialized
    const paths = systems.belt.beltPaths;
    assert(paths.length === extras.beltPaths.length, "Belt path count mismatch in snapshot");
    for (let i = 0; i < paths.length; ++i) {
        paths[i].totalLength = extras.beltPaths[i].totalLength;
        paths[i].numCompressedItemsAfterFirstItem = extras.beltPaths[i].numCompressedItemsAfterFirstItem;
    }

    const entities = root.entityMgr.entities;

    for (const [uid, data] of extras.processors) {
        const processor = entities.get(uid)?.components.ItemProcessor;
        if (!processor) {
            continue;
        }
        processor.inputSlots.clear();
        for (const [slot, item] of data.inputSlots) {
            processor.inputSlots.set(slot, deserializeItem(root, item));
        }
        processor.inputCount = data.inputCount;
        processor.bonusTime = data.bonusTime;
        processor.ongoingCharges = data.ongoingCharges.map(charge => ({
            remainingTime: charge.remainingTime,
            items: charge.items.map(item => deserializeEjectItem(root, item)),
        }));
        processor.queuedEjects = data.queuedEjects.map(item => deserializeEjectItem(root, item));
    }

    for (const [uid, data] of extras.beltReaders) {
        const reader = entities.get(uid)?.components.BeltReader;
        if (!reader) {
            continue;
        }
        reader.lastItemTimes = data.lastItemTimes.slice();
        reader.lastThroughput = data.lastThroughput;
        reader.lastThroughputComputation = data.lastThroughputComputation;
    }

    systems.miner.needsRecompute = extras.minerNeedsRecompute;
    for (const [uid, target] of extras.chainedMiners) {
        const miner = entities.get(uid)?.components.Miner;
        if (!miner) {
            continue;
        }
        miner.cachedChainedMiner = typeof target === "number" ? entities.get(target) ?? null : target;
    }

    // Wire networks are rebuilt lazily, but systems running before the wire
    // system would see no network in the first tick. Rebuild them right away
    // and restore the values they had.
    if (!extras.wireNeedsRecompute) {
        systems.wire.recomputeWiresNetwork();
        const byKey = new Map(extras.wireNetworks.map(network => [network.key, network]));
        for (const network of systems.wire.networks) {
            const saved = byKey.get(getNetworkKey(network));
            if (saved) {
                network.currentValue = deserializeItem(root, saved.value);
                network.valueConflict = saved.conflict;
            }
        }
    }
}
