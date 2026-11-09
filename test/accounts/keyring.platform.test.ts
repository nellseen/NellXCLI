import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SystemKeyringStore } from "../../src/accounts/secrets.js";

const shouldTestNativeKeyring =
  process.platform !== "linux" || process.env.NELLX_RUN_LINUX_KEYRING === "1";
const platformTest = shouldTestNativeKeyring ? it : it.skip;
const references: { store: SystemKeyringStore; reference: string }[] = [];
afterEach(async () => {
  await Promise.all(
    references.splice(0).map(({ store, reference }) => store.delete(reference)),
  );
});

describe("native OS keyring integration", () => {
  platformTest(
    "stores, reads, and deletes a disposable credential",
    async () => {
      const store = new SystemKeyringStore();
      const credentialId = randomUUID();
      const secret = `nellx-keyring-integration-${randomUUID()}`;
      const reference = await store.put(credentialId, secret);
      references.push({ store, reference });
      await expect(store.get(reference)).resolves.toBe(secret);
      await store.delete(reference);
      references.splice(
        references.findIndex((entry) => entry.reference === reference),
        1,
      );
      await expect(store.get(reference)).rejects.toThrow(
        /Unable to read this credential/,
      );
    },
  );
});
