import { WebIpcRenderer } from "./web_ipc";

declare global {
    interface Window {
        ipcRenderer?: unknown;
    }
}

/**
 * True when running in a regular browser, i.e. there is no Electron preload
 * script which would expose the ipcRenderer bridge.
 */
export const IS_WEB_PLATFORM = typeof window.ipcRenderer === "undefined";

if (IS_WEB_PLATFORM) {
    window.ipcRenderer = new WebIpcRenderer();
}
