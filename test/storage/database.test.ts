import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../../src/storage/database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalDatabase transactions", () => {
  it("awaits async operations and persists only committed changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nellx-db-"));
    directories.push(directory);
    const file = join(directory, "nellx.sqlite");
    const database = await LocalDatabase.open(file);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(
          "INSERT INTO settings (key, value) VALUES (?, ?)",
          ["temporary", "discard"],
        );
        await Promise.resolve();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(database.query("SELECT * FROM settings")).toEqual([]);
    await database.transaction(async (transaction) => {
      await transaction.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        ["committed", "yes"],
      );
    });
    database.close();

    const reopened = await LocalDatabase.open(file);
    expect(reopened.query("SELECT * FROM settings")).toMatchObject([
      { key: "committed", value: "yes" },
    ]);
    reopened.close();
  });
});
