import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSkillManager } from "../../src/skills/skill-manager.js";
const roots: string[] = [];
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
async function root() {
  const value = await mkdtemp(join(tmpdir(), "nellx-skills-"));
  roots.push(value);
  return value;
}
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  ),
);
describe("workspace skills", () => {
  it("validates metadata and reads instruction bodies", async () => {
    const workspace = await root();
    const directory = join(workspace, ".nellx", "skills", "tests");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: test-skill\ndescription: Run test guidance\n---\nUse the project test scripts.",
    );
    const manager = new WorkspaceSkillManager(workspace);
    await expect(manager.list()).resolves.toEqual([
      {
        name: "test-skill",
        description: "Run test guidance",
        directory: ".nellx/skills/tests",
      },
    ]);
    await expect(manager.read("test-skill")).resolves.toMatchObject({
      instructions: "Use the project test scripts.",
    });
  });
  it("does not follow skill directory symlinks outside the workspace", async () => {
    const workspace = await root();
    const outside = await root();
    const skills = join(workspace, ".nellx", "skills");
    await mkdir(skills, { recursive: true });
    await symlink(outside, join(skills, "escape"), directorySymlinkType);
    await expect(new WorkspaceSkillManager(workspace).list()).resolves.toEqual(
      [],
    );
  });
});
