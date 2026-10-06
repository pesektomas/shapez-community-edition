/**
 * Invite links have the form <origin>/w/<worldId>?k=<inviteKey>
 */

export function parseInviteLink(link: string): { worldId: string; inviteKey: string } | null {
    try {
        const url = new URL(link, location.href);
        const match = url.pathname.match(/\/w\/([A-Za-z0-9_-]+)\/?$/);
        const inviteKey = url.searchParams.get("k");
        if (match && inviteKey) {
            return { worldId: match[1], inviteKey };
        }
    } catch {
        // Not a link
    }
    return null;
}

export function getInvitePath(worldId: string, inviteKey: string) {
    return `/w/${worldId}?k=${encodeURIComponent(inviteKey)}`;
}

export function getInviteLink(worldId: string, inviteKey: string) {
    return location.origin + getInvitePath(worldId, inviteKey);
}
