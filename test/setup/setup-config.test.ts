import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../../src/storage/database.js";
import { SetupConfig } from "../../src/setup/setup-config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SetupConfig", () => {
  it("stores the selected profile, canonical model, and workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nellx-setup-"));
    directories.push(directory);
    const file = join(directory, "nellx.sqlite");
    const database = await LocalDatabase.open(file);
    const config = new SetupConfig(database);

    expect(config.get()).toEqual({});
    await config.save({
      defaultProfileId: "profile-1",
      defaultModel: "gemini-3.5-flash",
      defaultWorkspace: "/workspace/project",
    });
    expect(config.get()).toEqual({
      defaultProfileId: "profile-1",
      defaultModel: "gemini-3.5-flash",
      defaultWorkspace: "/workspace/project",
    });
    database.close();

    const reopened = await LocalDatabase.open(file);
    expect(new SetupConfig(reopened).get().defaultModel).toBe(
      "gemini-3.5-flash",
    );
    reopened.close();
  });
});
