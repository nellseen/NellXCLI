import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialService,
  EncryptedVaultStore,
  SystemKeyringStore,
  type SecretStore,
} from "../../src/accounts/secrets.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nellx-vault-"));
  directories.push(directory);
  return directory;
}

describe("encrypted credential vault", () => {
  it("encrypts secrets at rest and supports get/delete", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "credentials.vault");
    const vault = new EncryptedVaultStore(path, "a-secure-test-passphrase");
    const reference = await vault.put(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "very-secret-api-key",
    );

    expect(await vault.get(reference)).toBe("very-secret-api-key");
    expect(await readFile(path, "utf8")).not.toContain("very-secret-api-key");
    await vault.delete(reference);
    await expect(vault.get(reference)).rejects.toThrow(
      /missing from the encrypted vault/,
    );
  });

  it("rejects an incorrect passphrase", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "credentials.vault");
    const reference = await new EncryptedVaultStore(
      path,
      "first-secure-passphrase",
    ).put("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "secret");

    await expect(
      new EncryptedVaultStore(path, "other-secure-passphrase").get(reference),
    ).rejects.toThrow(/could not decrypt/);
  });

  it("falls back to the vault only when the system keyring fails", async () => {
    const directory = await temporaryDirectory();
    const vault = new EncryptedVaultStore(
      join(directory, "vault.json"),
      "secure-test-passphrase",
    );
    const unavailableKeyring: SecretStore = {
      put: async () => {
        throw new Error("platform detail should not escape");
      },
      get: async () => {
        throw new Error("unavailable");
      },
      delete: async () => {
        throw new Error("unavailable");
      },
    };
    const service = new CredentialService(unavailableKeyring, vault);
    const reference = await service.put(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "vaulted-key",
    );

    expect(reference).toContain("vault");
    expect(await service.get(reference)).toBe("vaulted-key");
  });

  it("uses the system keyring adapter and hides backend errors", async () => {
    const values = new Map<string, string>();
    const keyring = new SystemKeyringStore(async (id) => ({
      getPassword: async () => values.get(id) ?? null,
      setPassword: async (password) => {
        values.set(id, password);
      },
      deletePassword: async () => values.delete(id),
    }));
    const reference = await keyring.put(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "keyring-secret",
    );

    expect(await keyring.get(reference)).toBe("keyring-secret");
    await keyring.delete(reference);
    await expect(keyring.get(reference)).rejects.toThrow(
      /Unable to read this credential/,
    );
  });
});
