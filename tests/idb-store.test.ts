// Failure mode B2 in docs/failure-modes.md. Node has no IndexedDB.
import { expect, it } from "vitest";
import { idbStore } from "../src/idb-store.js";

it("B2: idbStore rejects with DenError when IndexedDB is not there", async () => {
  const store = idbStore();
  await expect(store.load("den")).rejects.toMatchObject({ name: "DenError", message: expect.stringMatching(/IndexedDB/) });
  await expect(store.save("den", new Map())).rejects.toMatchObject({ name: "DenError" });
});
