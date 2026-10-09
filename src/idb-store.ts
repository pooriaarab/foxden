// A DenStore in IndexedDB, so den files survive a page reload. It uses the
// origin of the page that calls it: the extension origin in an extension,
// the site origin on a website. One record per den holds all its files.
import type { DenStore } from "./den.js";
import { DenError } from "./errors.js";

type Record = { name: string; files: [string, Uint8Array][] };

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.addEventListener("success", () => resolve(r.result));
    r.addEventListener("error", () => reject(r.error ?? new DenError("An IndexedDB request failed.")));
  });
}

/** A store in the IndexedDB database `dbName` (default "foxden"). */
export function idbStore(dbName = "foxden"): DenStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (typeof indexedDB === "undefined") return Promise.reject(new DenError("IndexedDB is not available here, so idbStore cannot keep files. Use memoryStore()."));
    if (!db) {
      const r = indexedDB.open(dbName, 1);
      r.addEventListener("upgradeneeded", () => r.result.createObjectStore("dens", { keyPath: "name" }));
      db = request(r);
      db.catch(() => (db = undefined));
    }
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction("dens", mode).objectStore("dens");
  return {
    async load(name) {
      const record = (await request((await tx("readonly")).get(name))) as Record | undefined;
      return record ? new Map(record.files) : null;
    },
    async save(name, files) {
      await request((await tx("readwrite")).put({ name, files: [...files] } satisfies Record));
    },
    async remove(name) {
      await request((await tx("readwrite")).delete(name));
    },
  };
}
