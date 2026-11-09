import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountManager } from "../../src/accounts/account-manager.js";
import type { SecretStore } from "../../src/accounts/secrets.js";
import {
  ProviderRequestError,
  type TextProvider,
} from "../../src/providers/provider.js";
import { ProviderRouter } from "../../src/runtime/provider-router.js";
import { LocalDatabase } from "../../src/storage/database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async put(id: string, secret: string): Promise<string> {
    this.values.set(id, secret);
    return JSON.stringify({ id });
  }
  async get(reference: string): Promise<string> {
    const { id } = JSON.parse(reference) as { id: string };
    const secret = this.values.get(id);
    if (secret === undefined) throw new Error("credential missing");
    return secret;
  }
  async delete(reference: string): Promise<void> {
    const { id } = JSON.parse(reference) as { id: string };
    this.values.delete(id);
  }
}

async function setup(): Promise<{
  database: LocalDatabase;
  accounts: AccountManager;
  secrets: MemorySecrets;
}> {
  const directory = await mkdtemp(join(tmpdir(), "nellx-router-"));
  directories.push(directory);
  const database = await LocalDatabase.open(join(directory, "nellx.sqlite"));
  const secrets = new MemorySecrets();
  return { database, accounts: new AccountManager(database, secrets), secrets };
}

function makeProviderFactory(
  scripts: Map<string, Array<Array<string | Error>>>,
  calls: string[],
): (apiKey: string) => TextProvider {
  return (apiKey) => ({
    listModels: async () => [
      {
        id: "gemini-flash",
        displayName: "Flash",
        capabilities: ["textGeneration"],
      },
    ],
    async *streamText(): AsyncIterable<string> {
      calls.push(apiKey);
      const queue = scripts.get(apiKey) ?? [];
      const next = queue.shift() ?? ["ok"];
      scripts.set(apiKey, queue);
      for (const item of next) {
        if (item instanceof Error) throw item;
        yield item;
      }
    },
  });
}

async function addAccount(
  accounts: AccountManager,
  name: string,
  projectId: string,
  key: string,
  priority = 0,
): Promise<void> {
  const profile = await accounts.addProfile({
    displayName: name,
    projectId,
    priority,
  });
  await accounts.addApiKey(profile.id, key);
}

async function collect(router: ProviderRouter): Promise<string[]> {
  const result: string[] = [];
  for await (const chunk of router.streamText({
    model: "gemini-flash",
    prompt: "task",
  }))
    result.push(chunk);
  return result;
}

describe("ProviderRouter", () => {
  it("fails over project-wide quota without trying another key in the same project", async () => {
    const { database, accounts } = await setup();
    await addAccount(accounts, "Project A", "project-a", "key-a1", 20);
    await addAccount(
      accounts,
      "Project A second key",
      "project-a",
      "key-a2",
      19,
    );
    await addAccount(accounts, "Project B", "project-b", "key-b", 10);
    const scripts = new Map<string, Array<Array<string | Error>>>([
      ["key-a1", [[new ProviderRequestError("quota_exhausted", "quota")]]],
      ["key-a2", [["must-not-run"]]],
      ["key-b", [["response from B"]]],
    ]);
    const streamCalls: string[] = [];
    const events: string[] = [];
    const router = new ProviderRouter(
      accounts,
      makeProviderFactory(scripts, streamCalls),
      {
        onEvent: (event) => {
          events.push(event.type);
        },
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    await expect(collect(router)).resolves.toEqual(["response from B"]);
    expect(streamCalls).toEqual(["key-a1", "key-b"]);
    expect(
      await accounts.getEligibleProjectIds(
        "gemini-flash",
        new Date("2026-01-01T00:01:00.000Z"),
      ),
    ).toEqual(["project-b"]);
    expect(events).toContain("provider_cooldown");
    database.close();
  });

  it("quarantines an invalid key and can use another key for the same project", async () => {
    const { database, accounts } = await setup();
    const firstProfile = await accounts.addProfile({
      displayName: "Bad key",
      projectId: "project-a",
      priority: 10,
    });
    const badCredential = await accounts.addApiKey(firstProfile.id, "bad-key");
    await addAccount(accounts, "Good key", "project-a", "good-key", 9);
    await addAccount(accounts, "Other project", "project-b", "key-b", 1);
    const scripts = new Map<string, Array<Array<string | Error>>>([
      [
        "bad-key",
        [[new ProviderRequestError("authentication", "invalid key")]],
      ],
      ["good-key", [["same project recovered"]]],
      ["key-b", [["must-not-run"]]],
    ]);
    const calls: string[] = [];
    const router = new ProviderRouter(
      accounts,
      makeProviderFactory(scripts, calls),
      { maxTransientRetries: 0 },
    );

    await expect(collect(router)).resolves.toEqual(["same project recovered"]);
    expect(calls).toEqual(["bad-key", "good-key"]);
    expect(await accounts.getCredential(badCredential.id)).toMatchObject({
      enabled: false,
      status: "quarantined",
    });
    database.close();
  });

  it("surfaces permission errors without trying another project", async () => {
    const { database, accounts } = await setup();
    await addAccount(accounts, "Project A", "project-a", "key-a", 10);
    await addAccount(accounts, "Project B", "project-b", "key-b", 0);
    const scripts = new Map<string, Array<Array<string | Error>>>([
      [
        "key-a",
        [[new ProviderRequestError("permission", "permission denied")]],
      ],
      ["key-b", [["must-not-run"]]],
    ]);
    const calls: string[] = [];
    const router = new ProviderRouter(
      accounts,
      makeProviderFactory(scripts, calls),
    );

    await expect(collect(router)).rejects.toMatchObject({
      category: "permission",
    });
    expect(calls).toEqual(["key-a"]);
    database.close();
  });

  it("bounds transient retries and uses jittered exponential delays", async () => {
    const { database, accounts } = await setup();
    await addAccount(accounts, "Project A", "project-a", "key-a", 10);
    await addAccount(accounts, "Project B", "project-b", "key-b", 0);
    const scripts = new Map<string, Array<Array<string | Error>>>([
      [
        "key-a",
        [
          [new ProviderRequestError("temporary_server", "503")],
          [new ProviderRequestError("temporary_server", "503")],
        ],
      ],
      ["key-b", [["success"]]],
    ]);
    const calls: string[] = [];
    const delays: number[] = [];
    const router = new ProviderRouter(
      accounts,
      makeProviderFactory(scripts, calls),
      {
        maxTransientRetries: 1,
        baseDelayMs: 200,
        random: () => 0.5,
        wait: async (delay) => {
          delays.push(delay);
        },
      },
    );

    await expect(collect(router)).resolves.toEqual(["success"]);
    expect(calls).toEqual(["key-a", "key-a", "key-b"]);
    expect(delays).toEqual([200]);
    database.close();
  });

  it("does not replay a stream after visible partial output", async () => {
    const { database, accounts } = await setup();
    await addAccount(accounts, "Project A", "project-a", "key-a", 10);
    await addAccount(accounts, "Project B", "project-b", "key-b", 0);
    const scripts = new Map<string, Array<Array<string | Error>>>([
      [
        "key-a",
        [["partial", new ProviderRequestError("temporary_server", "503")]],
      ],
      ["key-b", [["must-not-run"]]],
    ]);
    const calls: string[] = [];
    const router = new ProviderRouter(
      accounts,
      makeProviderFactory(scripts, calls),
    );
    const output: string[] = [];

    await expect(async () => {
      for await (const chunk of router.streamText({
        model: "gemini-flash",
        prompt: "task",
      }))
        output.push(chunk);
    }).rejects.toMatchObject({ category: "temporary_server" });
    expect(output).toEqual(["partial"]);
    expect(calls).toEqual(["key-a"]);
    database.close();
  });
});
