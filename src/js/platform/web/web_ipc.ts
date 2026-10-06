import { IdbFileSystem } from "./idb_fs";

interface FsJob {
    id: string;
    type: string;
    filename?: string;
    contents?: Uint8Array;
    extension?: string;
}

/**
 * Browser replacement for the ipcRenderer bridge exposed by the Electron
 * preload script. Implements the same channels the game uses, so that the
 * original Electron-oriented code (Storage, ModLoader, ...) keeps working.
 */
export class WebIpcRenderer {
    private readonly fileSystems = new Map<string, IdbFileSystem>();

    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
        switch (channel) {
            case "fs-job":
                return this.handleFsJob(args[0] as FsJob);
            case "get-mods":
                // Mods are loaded from the filesystem, not supported on the web
                return Promise.resolve([]);
            case "set-fullscreen":
                return this.setFullscreen(Boolean(args[0]));
        }

        return Promise.reject(new Error(`Unknown IPC channel on web platform: ${channel}`));
    }

    on(_channel: string, _listener: (...args: unknown[]) => void): void {
        // No main process which could send events
    }

    send(_channel: string, ..._args: unknown[]): void {
        // No main process to send events to
    }

    private getFileSystem(id: string): IdbFileSystem {
        let fs = this.fileSystems.get(id);
        if (!fs) {
            fs = new IdbFileSystem(id);
            this.fileSystems.set(id, fs);
        }
        return fs;
    }

    private handleFsJob(job: FsJob): Promise<unknown> {
        const fs = this.getFileSystem(job.id);

        switch (job.type) {
            case "initialize":
                return fs.initialize();
            case "read":
                return fs.read(job.filename);
            case "write":
                return fs.write(job.filename, job.contents);
            case "delete":
                return fs.delete(job.filename);
            case "list":
                return fs.list(job.filename);
            case "open-external":
                return openFileDialog(job.extension);
            case "save-external":
                return downloadFile(job.filename, job.contents);
        }

        return Promise.reject(new Error(`Unknown FS job type: ${job.type}`));
    }

    private async setFullscreen(flag: boolean): Promise<void> {
        try {
            if (flag && !document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else if (!flag && document.fullscreenElement) {
                await document.exitFullscreen();
            }
        } catch (err) {
            // Browsers only allow fullscreen from a user gesture, ignore
            console.warn("Failed to change fullscreen state:", err);
        }
    }
}

function openFileDialog(extension: string): Promise<Uint8Array | undefined> {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        if (extension && extension !== "*") {
            input.accept = "." + extension;
        }

        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            resolve(file ? new Uint8Array(await file.arrayBuffer()) : undefined);
        });
        input.addEventListener("cancel", () => resolve(undefined));

        input.click();
    });
}

async function downloadFile(filename: string, contents: Uint8Array): Promise<void> {
    const blob = new Blob([contents.slice()], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
