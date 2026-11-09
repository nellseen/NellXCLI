import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountManager } from "../../src/accounts/account-manager.js";
import type { SecretStore } from "../../src/accounts/secrets.js";
import { LocalDatabase } from "../../src/storage/database.js";

const directories: string[] = [];

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  async put(credentialId: string, secret: string): Promise<string> {
    this.values.set(credentialId, secret);
    return JSON.stringify({ backend: "test", credentialId });
  }

  async get(reference: string): Promise<string> {
    const { credentialId } = JSON.parse(reference) as { credentialId: string };
    const secret = this.values.get(credentialId);
    if (!secret) throw new Error("secret missing");
    return secret;
  }

  async delete(reference: string): Promise<void> {
    const { credentialId } = JSON.parse(reference) as { credentialId: string };
    this.values.delete(credentialId);
  }
}

async function createManager(): Promise<{
  manager: AccountManager;
  secrets: MemorySecrets;
  database: LocalDatabase;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "nellx-accounts-"));
  directories.push(directory);
  const database = await LocalDatabase.open(join(directory, "nellx.sqlite"));
  const secrets = new MemorySecrets();
  return {
    manager: new AccountManager(database, secrets),
    secrets,
    database,
    directory,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AccountManager", () => {
  it("keeps API keys out of SQLite and groups duplicate profiles by project", async () => {
    const { manager, secrets, database, directory } = await createManager();
    const first = await manager.addProfile({
      displayName: "Personal",
      projectId: "project-1",
    });
    const second = await manager.addProfile({
      displayName: "Work",
      projectId: "project-1",
    });
    const firstKey = await manager.addApiKey(first.id, "secret-test-key-1");
    const secondKey = await manager.addApiKey(second.id, "secret-test-key-2");

    expect(
      (await manager.listProfiles()).map((profile) => profile.credentialCount),
    ).toEqual([1, 1]);
    expect(secrets.values.size).toBe(2);
    expect(await manager.getEligibleProjectIds("gemini-flash")).toEqual([
      "project-1",
    ]);
    const databaseBytes = await readFile(join(directory, "nellx.sqlite"));
    expect(databaseBytes.includes(Buffer.from("secret-test-key-1"))).toBe(
      false,
    );
    expect(databaseBytes.includes(Buffer.from("secret-test-key-2"))).toBe(
      false,
    );
    expect(await manager.getApiKey(firstKey.id)).toBe("secret-test-key-1");
    expect(await manager.getApiKey(secondKey.id)).toBe("secret-test-key-2");
    database.close();
  });

  it("shares project/model cooldown across keys and profiles", async () => {
    const { manager, database } = await createManager();
    const first = await manager.addProfile({
      displayName: "One",
      projectId: "same-project",
    });
    const second = await manager.addProfile({
      displayName: "Two",
      projectId: "same-project",
    });
    await manager.addApiKey(first.id, "key-one");
    await manager.addApiKey(second.id, "key-two");

    await manager.recordProjectFailure(
      "same-project",
      "gemini-flash",
      "quota_exhausted",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(await manager.getEligibleProjectIds("gemini-flash")).toEqual([]);
    expect(await manager.listProjectHealth()).toMatchObject([
      { projectId: "same-project", model: "gemini-flash", status: "cooldown" },
    ]);
    database.close();
  });

  it("quarantines invalid credentials and removes profile secrets safely", async () => {
    const { manager, secrets, database } = await createManager();
    const profile = await manager.addProfile({
      displayName: "Test",
      projectId: "project",
    });
    const credential = await manager.addApiKey(profile.id, "key-value");

    await manager.quarantineCredential(credential.id);
    await expect(manager.getApiKey(credential.id)).rejects.toThrow(
      /unavailable or requires user action/,
    );
    expect(await manager.getEligibleProjectIds("model")).toEqual([]);
    await manager.removeProfile(profile.id);
    expect(await manager.listProfiles()).toEqual([]);
    expect(secrets.values.size).toBe(0);
    database.close();
  });

  it("validates external profile data", async () => {
    const { manager, database } = await createManager();
    await expect(
      manager.addProfile({ displayName: " ", projectId: "" }),
    ).rejects.toThrow();
    database.close();
  });
});
