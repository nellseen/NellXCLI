import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinToolRegistry } from "../../src/tools/builtins.js";
import type { ToolContext } from "../../src/tools/registry.js";

const roots: string[] = [];
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "nellx-tools-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("built-in tools", () => {
  it("reads and writes only within workspace", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "hello");
    const registry = createBuiltinToolRegistry();
    const context: ToolContext = { workspace: root, mode: "auto" };
    await expect(
      registry.execute("read_file", { path: "a.txt" }, context),
    ).resolves.toEqual({ path: "a.txt", content: "hello" });
    await expect(
      registry.execute(
        "write_file",
        { path: "../escape.txt", content: "no" },
        context,
      ),
    ).rejects.toThrow(/outside|traversal/i);
    await expect(
      registry.execute(
        "write_file",
        { path: "nested/b.txt", content: "yes" },
        context,
      ),
    ).resolves.toMatchObject({ path: "nested/b.txt" });
    await expect(readFile(join(root, "nested/b.txt"), "utf8")).resolves.toBe(
      "yes",
    );
  });

  it("honors gitignore patterns, negations, and protects credential files", async () => {
    const root = await workspace();
    await writeFile(
      join(root, ".gitignore"),
      "*.log\n!important.log\nbuild/\n!.nellx/\n!.nellx/tasks/\n!.nellx/tasks/task.json\n",
    );
    await writeFile(join(root, "hidden.log"), "ignored");
    await writeFile(join(root, "important.log"), "included");
    await writeFile(join(root, ".env"), "API_KEY=secret");
    await writeFile(join(root, "visible.txt"), "visible");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
    await writeFile(join(root, "nested", "hidden.tmp"), "hidden");
    await writeFile(
      join(root, "nested", "keep.tmp"),
      "included by nested negation",
    );
    await mkdir(join(root, ".nellx", "tasks"), { recursive: true });
    await writeFile(
      join(root, ".nellx", "tasks", "task.json"),
      "private status",
    );
    const registry = createBuiltinToolRegistry();
    const context: ToolContext = { workspace: root, mode: "auto" };
    const files = await registry.execute(
      "list_files",
      { path: ".", depth: 2 },
      context,
    );
    expect(files).toContain("important.log");
    expect(files).toContain("visible.txt");
    expect(files).toContain(join("nested", "keep.tmp"));
    expect(files).not.toContain(join("nested", "hidden.tmp"));
    expect(files).not.toContain("hidden.log");
    expect(files).not.toContain(".env");
    expect(files).not.toContain(join(".nellx", "tasks", "task.json"));
    await expect(
      registry.execute("read_file", { path: ".env" }, context),
    ).rejects.toThrow(/credential/i);
  });

  it("rejects writing through symlinks and requires approval in Normal mode", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "victim"), "safe");
    await symlink(outside, join(root, "outside"), directorySymlinkType);
    const registry = createBuiltinToolRegistry();
    await expect(
      registry.execute(
        "write_file",
        { path: "outside/victim", content: "bad" },
        { workspace: root, mode: "auto" },
      ),
    ).rejects.toThrow(/symbolic link/i);
    const ask = vi.fn<(summary: string) => Promise<boolean>>(async () => false);
    await expect(
      registry.execute(
        "write_file",
        { path: "new.txt", content: "bad" },
        { workspace: root, mode: "normal", requestApproval: ask },
      ),
    ).rejects.toThrow(/not approved/i);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[0]).toContain(`Workspace: ${root}`);
    expect(ask.mock.calls[0]?.[0]).toContain('"path":"new.txt"');
    expect(ask.mock.calls[0]?.[0]).toContain('"content":"bad"');
  });

  it("requires shell approval and does not accept malformed tool inputs", async () => {
    const root = await workspace();
    const registry = createBuiltinToolRegistry();
    await expect(
      registry.execute(
        "shell",
        { program: "git", args: ["status"] },
        { workspace: root, mode: "auto" },
      ),
    ).rejects.toThrow(/approval/i);
    await expect(
      registry.execute(
        "apply_patch",
        { path: "x", oldText: "", newText: "a" },
        { workspace: root, mode: "auto" },
      ),
    ).rejects.toThrow();
  });
  it("shows the approved argv while redacting sensitive values", async () => {
    const root = await workspace();
    const registry = createBuiltinToolRegistry();
    const ask = vi.fn<(summary: string) => Promise<boolean>>(async () => false);
    await expect(
      registry.execute(
        "shell",
        {
          program: "node",
          args: ["-e", "console.log('api_key=AIza123456789012345678901234')"],
        },
        { workspace: root, mode: "auto", requestApproval: ask },
      ),
    ).rejects.toThrow(/not approved/);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[0]).toContain('"program":"node"');
    expect(ask.mock.calls[0]?.[0]).toContain("[REDACTED");
    expect(ask.mock.calls[0]?.[0]).not.toContain(
      "AIza123456789012345678901234",
    );
  });
});
