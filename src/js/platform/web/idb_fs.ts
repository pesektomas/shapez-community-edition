/**
 * Minimal key-value "filesystem" on top of IndexedDB. Each storage id
 * (e.g. "saves") maps to a key prefix inside a single object store.
 */

const DB_NAME = "tvarovna";
const DB_VERSION = 1;
const STORE_NAME = "files";

export class IdbNotFoundError extends Error {
    constructor(key: string) {
        // NOTE: Mimics the message format of a failed Electron IPC call so that
        // FsError can extract the error code (see fs_error.ts)
        super(`Error invoking remote method 'fs-job': Error: ENOENT: no such file or directory, '${key}'`);
        this.name = "IdbNotFoundError";
    }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
    if (dbPromise) {
        return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            dbPromise = null;
            reject(request.error ?? new Error("Failed to open IndexedDB"));
        };
        request.onblocked = () => reject(new Error("IndexedDB open request was blocked"));
    });

    return dbPromise;
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, mode);
    const result = await wrapRequest(fn(tx.objectStore(STORE_NAME)));

    if (mode === "readwrite") {
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
        });
    }

    return result;
}

export class IdbFileSystem {
    readonly prefix: string;

    constructor(id: string) {
        this.prefix = id + "/";
    }

    async initialize(): Promise<void> {
        await openDatabase();
    }

    async read(filename: string): Promise<Uint8Array> {
        const key = this.prefix + filename;
        const value = await withStore("readonly", store => store.get(key));
        if (value === undefined) {
            throw new IdbNotFoundError(key);
        }

        return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    }

    async write(filename: string, contents: Uint8Array): Promise<void> {
        // Store a copy which owns its buffer, the original might get transferred
        const copy = contents.slice();
        await withStore("readwrite", store => store.put(copy, this.prefix + filename));
    }

    async delete(filename: string): Promise<void> {
        const key = this.prefix + filename;
        const count = await withStore("readonly", store => store.count(key));
        if (count === 0) {
            throw new IdbNotFoundError(key);
        }

        await withStore("readwrite", store => store.delete(key));
    }

    async list(subdir: string): Promise<string[]> {
        const base = this.prefix + (subdir ? subdir.replace(/\/?$/, "/") : "");
        const range = IDBKeyRange.bound(base, base + "￿");
        const keys = await withStore("readonly", store => store.getAllKeys(range));
        return keys.map(key => String(key).slice(base.length)).filter(name => !name.includes("/"));
    }
}
