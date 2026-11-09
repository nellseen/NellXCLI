import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkspaceInstructionTree,
  loadWorkspaceInstructions,
} from "../../src/runtime/workspace-instructions.js";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
describe("workspace instructions", () => {
  it("rejects AGENTS.md symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-instructions-"));
    const outside = await mkdtemp(join(tmpdir(), "nellx-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "AGENTS.md"), "outside rules");
    if (process.platform === "win32") {
      await symlink(outside, join(root, "nested"), "junction");
      await expect(loadWorkspaceInstructions(root, "nested")).rejects.toThrow(
        /inside the workspace/,
      );
    } else {
      await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
      await expect(loadWorkspaceInstructions(root)).rejects.toThrow(
        /inside the workspace/,
      );
    }
  });

  it("discovers nested instructions in a bounded tree without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-instructions-"));
    const outside = await mkdtemp(join(tmpdir(), "nellx-outside-"));
    roots.push(root, outside);
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await mkdir(join(root, "one", "two"), { recursive: true });
    await mkdir(join(outside, "linked"), { recursive: true });
    await writeFile(join(root, "one", "AGENTS.md"), "one rules");
    await writeFile(join(root, "one", "two", "AGENTS.md"), "two rules");
    await writeFile(join(outside, "linked", "AGENTS.md"), "outside rules");
    await symlink(
      join(outside, "linked"),
      join(root, "one", "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(loadWorkspaceInstructionTree(root, ".", 1)).resolves.toEqual([
      "# Instructions from AGENTS.md\nroot rules",
      "# Instructions from one/AGENTS.md\none rules",
    ]);
  });

  it("loads instructions from root to nested directory in precedence order", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-instructions-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "AGENTS.md"), "nested rules");
    await expect(loadWorkspaceInstructions(root, "src")).resolves.toEqual([
      "# Instructions from AGENTS.md\nroot rules",
      "# Instructions from src/AGENTS.md\nnested rules",
    ]);
  });
});
