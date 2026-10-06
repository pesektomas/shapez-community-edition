import { globalConfig } from "../../core/config";
import type { DrawParameters } from "../../core/draw_parameters";
import { gMetaBuildingRegistry } from "../../core/global_registries";
import { Vector } from "../../core/vector";
import type { Entity } from "../../game/entity";
import { BaseHUDPart } from "../../game/hud/base_hud_part";

/** Own cursor is sent at most this often */
const CURSOR_SEND_INTERVAL_MS = 100;
/** Cursors which did not move for this long are hidden */
const CURSOR_TIMEOUT_MS = 20_000;

interface RemoteCursor {
    x: number;
    y: number;
    displayX: number;
    displayY: number;
    layer: string;
    updatedAt: number;
}

/**
 * Draws in world space: the cursors of the other players and a preview
 * ("ghost") of the own actions which were sent but not applied yet.
 */
export class HUDCoopWorldOverlay extends BaseHUDPart {
    private cursors = new Map<number, RemoteCursor>();
    private lastSentAt = 0;
    private lastSent = "";

    /** Preview entities of pending placements, by clientSeq */
    private ghosts = new Map<number, Entity | null>();

    override initialize() {
        this.root.coop.signals.cursor.add((playerId, x, y, layer) => {
            const cursor = this.cursors.get(playerId);
            if (cursor) {
                Object.assign(cursor, { x, y, layer, updatedAt: performance.now() });
            } else {
                this.cursors.set(playerId, {
                    x,
                    y,
                    displayX: x,
                    displayY: y,
                    layer,
                    updatedAt: performance.now(),
                });
            }
        });
    }

    override update() {
        this.sendOwnCursor();
    }

    private sendOwnCursor() {
        const now = performance.now();
        const mouse = this.root.app.mousePosition;
        if (!mouse || now - this.lastSentAt < CURSOR_SEND_INTERVAL_MS) {
            return;
        }
        const world = this.root.camera.screenToWorld(mouse);
        const x = Math.round((world.x / globalConfig.tileSize) * 100) / 100;
        const y = Math.round((world.y / globalConfig.tileSize) * 100) / 100;
        const key = `${x}|${y}|${this.root.currentLayer}`;
        if (key === this.lastSent) {
            return;
        }
        this.lastSent = key;
        this.lastSentAt = now;
        this.root.coop.transport.sendCursor?.(x, y, this.root.currentLayer);
    }

    override draw(parameters: DrawParameters) {
        this.drawGhosts(parameters);
        this.drawCursors(parameters);
    }

    private drawGhosts(parameters: DrawParameters) {
        const pending = this.root.coop.pendingActions;
        const alive = new Set<number>();
        const context = parameters.context;

        for (const action of pending) {
            if (action.type === "placeBuilding") {
                alive.add(action.clientSeq);
                let ghost = this.ghosts.get(action.clientSeq);
                if (ghost === undefined) {
                    ghost = this.createGhost(action.payload);
                    this.ghosts.set(action.clientSeq, ghost);
                }
                if (ghost && ghost.layer === this.root.currentLayer) {
                    const staticComp = ghost.components.StaticMapEntity;
                    context.globalAlpha = 0.6;
                    staticComp.drawSpriteOnBoundsClipped(parameters, staticComp.getBlueprintSprite(), 0);
                    context.globalAlpha = 1;
                }
            } else if (action.type === "deleteBuildings") {
                // Mark buildings which are about to be removed
                context.fillStyle = "rgba(255, 70, 70, 0.35)";
                for (const uid of action.payload.uids) {
                    const entity = this.root.entityMgr.findByUid(uid, false);
                    if (entity && entity.layer === this.root.currentLayer) {
                        const rect = entity.components.StaticMapEntity.getTileSpaceBounds();
                        context.fillRect(
                            rect.x * globalConfig.tileSize,
                            rect.y * globalConfig.tileSize,
                            rect.w * globalConfig.tileSize,
                            rect.h * globalConfig.tileSize
                        );
                    }
                }
            }
        }

        for (const seq of this.ghosts.keys()) {
            if (!alive.has(seq)) {
                this.ghosts.delete(seq);
            }
        }
    }

    private createGhost(payload: {
        x: number;
        y: number;
        building: string;
        variant: string;
        rotation: number;
    }) {
        const building = gMetaBuildingRegistry.getEntries().find(meta => meta.getId() === payload.building);
        if (!building) {
            return null;
        }
        const tile = new Vector(payload.x, payload.y);
        const optimal = building.computeOptimalDirectionAndRotationVariantAtTile({
            root: this.root,
            tile,
            rotation: payload.rotation,
            variant: payload.variant,
            layer: building.getLayer(),
        });
        return building.createEntity({
            root: this.root,
            origin: tile,
            rotation: optimal.rotation,
            originalRotation: payload.rotation,
            rotationVariant: optimal.rotationVariant,
            variant: payload.variant,
        });
    }

    private drawCursors(parameters: DrawParameters) {
        const context = parameters.context;
        const now = performance.now();
        const zoom = this.root.camera.zoomLevel;
        const scale = 1 / zoom;

        for (const [playerId, cursor] of this.cursors) {
            const player = this.root.coop.getPlayer(playerId);
            if (!player || !player.online || now - cursor.updatedAt > CURSOR_TIMEOUT_MS) {
                continue;
            }

            // Smooth movement between the updates
            cursor.displayX += (cursor.x - cursor.displayX) * 0.3;
            cursor.displayY += (cursor.y - cursor.displayY) * 0.3;

            const x = cursor.displayX * globalConfig.tileSize;
            const y = cursor.displayY * globalConfig.tileSize;
            const alpha = cursor.layer === this.root.currentLayer ? 1 : 0.4;

            context.save();
            context.globalAlpha = alpha;
            context.translate(x, y);
            context.scale(scale, scale);

            // Arrow
            context.fillStyle = player.color;
            context.strokeStyle = "#fff";
            context.lineWidth = 2;
            context.beginPath();
            context.moveTo(0, 0);
            context.lineTo(0, 18);
            context.lineTo(5, 14);
            context.lineTo(9, 22);
            context.lineTo(12, 20);
            context.lineTo(8, 13);
            context.lineTo(14, 13);
            context.closePath();
            context.stroke();
            context.fill();

            // Name tag
            context.font = "bold 12px GameFont";
            const width = context.measureText(player.name).width + 10;
            context.fillStyle = player.color;
            context.beginPath();
            context.roundRect(14, 18, width, 18, 4);
            context.fill();
            context.fillStyle = "#fff";
            context.fillText(player.name, 19, 31);
            context.restore();
        }
    }
}
