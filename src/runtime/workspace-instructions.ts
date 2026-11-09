import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const MAX_INSTRUCTION_BYTES = 100_000;

/** Loads AGENTS.md from the workspace root down to the current workspace-relative directory. */
export async function loadWorkspaceInstructions(
  workspace: string,
  workingDirectory = ".",
): Promise<string[]> {
  const root = await realpath(workspace);
  const target = await realpath(join(root, workingDirectory));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Instruction directory must stay inside the workspace.");
  const directories = [root];
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    directories.push(current);
  }
  const instructions: string[] = [];
  let totalBytes = 0;
  for (const directory of directories) {
    try {
      const file = join(directory, "AGENTS.md");
      const resolvedFile = await realpath(file);
      const absoluteFileRel = relative(root, resolvedFile);
      if (
        absoluteFileRel === ".." ||
        absoluteFileRel.startsWith(`..${sep}`) ||
        isAbsolute(absoluteFileRel)
      )
        throw new Error(
          "Workspace instructions must stay inside the workspace.",
        );
      const fileRel = absoluteFileRel.split(sep).join("/");
      const text = await readFile(resolvedFile, "utf8");
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > MAX_INSTRUCTION_BYTES)
        throw new Error("Workspace instructions exceed the 100 KB limit.");
      instructions.push(
        `# Instructions from ${fileRel || "AGENTS.md"}\n${text}`,
      );
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return instructions;
}
/**
 * Loads ancestor instructions and instructions in a bounded directory tree.
 * Used before recursive tools that may inspect files below their target path.
 */
export async function loadWorkspaceInstructionTree(
  workspace: string,
  workingDirectory: string,
  maxDepth: number,
): Promise<string[]> {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5)
    throw new Error("Instruction discovery depth must be between 0 and 5.");
  const root = await realpath(workspace);
  const target = await realpath(join(root, workingDirectory));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Instruction directory must stay inside the workspace.");
  const directories: string[] = [];
  let totalDirectories = 0;
  const excluded = new Set([".git", "node_modules", "dist", ".nellx"]);
  const visit = async (directory: string, depth: number): Promise<void> => {
    totalDirectories += 1;
    if (totalDirectories > 1000)
      throw new Error(
        "Instruction discovery exceeded 1,000 directories. Narrow the file operation path.",
      );
    directories.push(directory);
    if (depth >= maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        excluded.has(entry.name.toLowerCase())
      )
        continue;
      const child = join(directory, entry.name);
      const resolved = await realpath(child);
      const childRel = relative(root, resolved);
      if (
        childRel === ".." ||
        childRel.startsWith(`..${sep}`) ||
        isAbsolute(childRel)
      )
        throw new Error(
          "Instruction directory must stay inside the workspace.",
        );
      await visit(resolved, depth + 1);
    }
  };
  const ancestors = await loadWorkspaceInstructions(root, rel || ".");
  await visit(target, 0);
  const existingPaths = new Set(
    ancestors.map(
      (instruction) => instruction.match(/^# Instructions from (.+)$/m)?.[1],
    ),
  );
  const instructions = [...ancestors];
  let totalBytes = ancestors.reduce(
    (sum, instruction) => sum + Buffer.byteLength(instruction),
    0,
  );
  for (const directory of directories) {
    const file = join(directory, "AGENTS.md");
    try {
      const resolvedFile = await realpath(file);
      const absoluteFileRel = relative(root, resolvedFile);
      if (
        absoluteFileRel === ".." ||
        absoluteFileRel.startsWith(`..${sep}`) ||
        isAbsolute(absoluteFileRel)
      )
        throw new Error(
          "Workspace instructions must stay inside the workspace.",
        );
      const fileRel = absoluteFileRel.split(sep).join("/");
      if (existingPaths.has(fileRel)) continue;
      const text = await readFile(resolvedFile, "utf8");
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > MAX_INSTRUCTION_BYTES)
        throw new Error("Workspace instructions exceed the 100 KB limit.");
      instructions.push(
        `# Instructions from ${fileRel || "AGENTS.md"}\n${text}`,
      );
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return instructions;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
