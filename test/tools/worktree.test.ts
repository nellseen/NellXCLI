import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinToolRegistry } from "../../src/tools/builtins.js";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
describe("git worktree tools", () => {
  it("creates and removes a contained worktree with approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-worktree-"));
    roots.push(root);
    const init = spawnSync("git", ["init", root]);
    expect(init.status).toBe(0);
    await writeFile(join(root, "README.md"), "root");
    spawnSync("git", ["-C", root, "add", "README.md"]);
    spawnSync("git", [
      "-C",
      root,
      "-c",
      "user.name=NellX",
      "-c",
      "user.email=nellx@example.invalid",
      "commit",
      "-m",
      "init",
    ]);
    const approve = vi.fn(async () => true);
    const registry = createBuiltinToolRegistry();
    const context = {
      workspace: root,
      mode: "auto" as const,
      requestApproval: approve,
    };
    await expect(
      registry.execute("git_worktree_create", { name: "review_1" }, context),
    ).resolves.toMatchObject({ path: join(".nellx", "worktrees", "review_1") });
    await expect(
      registry.execute("git_worktree_remove", { name: "review_1" }, context),
    ).resolves.toMatchObject({ removed: true });
    expect(approve).toHaveBeenCalledTimes(2);
  });
});
