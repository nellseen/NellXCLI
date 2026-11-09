import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

const MetadataSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().trim().min(1).max(500),
});
export interface WorkspaceSkill {
  name: string;
  description: string;
  directory: string;
}

export class WorkspaceSkillManager {
  constructor(private readonly workspace: string) {}

  async list(): Promise<WorkspaceSkill[]> {
    const root = await realpath(this.workspace);
    const skillsRoot = join(root, ".nellx", "skills");
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      },
    );
    const skills: WorkspaceSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = await realpath(join(skillsRoot, entry.name));
      assertWithin(root, directory);
      const document = await readFile(
        join(directory, "SKILL.md"),
        "utf8",
      ).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (document === undefined || Buffer.byteLength(document) > 30_000)
        continue;
      const parsed = parseSkillDocument(document);
      if (parsed)
        skills.push({ ...parsed, directory: relative(root, directory) });
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  async read(
    name: string,
  ): Promise<{ skill: WorkspaceSkill; instructions: string }> {
    const skill = (await this.list()).find((item) => item.name === name);
    if (!skill)
      throw new Error("Workspace skill was not found or has invalid metadata.");
    const root = await realpath(this.workspace);
    const directory = await realpath(join(root, skill.directory));
    assertWithin(root, directory);
    const document = await readFile(join(directory, "SKILL.md"), "utf8");
    const body = document.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return { skill, instructions: body };
  }
}

function parseSkillDocument(
  document: string,
): Omit<WorkspaceSkill, "directory"> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(document);
  if (!match?.[1]) return undefined;
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values.set(
      line.slice(0, separator).trim(),
      line
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, ""),
    );
  }
  const parsed = MetadataSchema.safeParse({
    name: values.get("name"),
    description: values.get("description"),
  });
  return parsed.success ? parsed.data : undefined;
}
function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Workspace skill path escaped the workspace.");
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
