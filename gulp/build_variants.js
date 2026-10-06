/**
 * @type {Record<string, {
 *  standalone: boolean
 * }>}
 */
export const BUILD_VARIANTS = {
    standalone: {
        standalone: true,
    },
    // COOP: Static build which runs in a regular browser
    web: {
        standalone: false,
    },
};
