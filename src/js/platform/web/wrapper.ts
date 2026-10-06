import { PlatformWrapperImplElectron } from "../wrapper";

/**
 * Platform wrapper for regular browsers. Most of the behavior is shared with
 * the Electron wrapper, only the bits which require a main process differ.
 */
export class PlatformWrapperImplWeb extends PlatformWrapperImplElectron {
    override getId() {
        return "web";
    }

    override openExternalLink(url: string) {
        window.open(url, "_blank", "noopener");
    }

    override getSupportsFullscreen() {
        return document.fullscreenEnabled;
    }

    override getSupportsAppExit() {
        return false;
    }

    override exitApp() {
        // Closing the tab is not possible (nor desirable) from a web page
    }
}
