import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export async function resolveWorkspacePath(
  workspace: string,
  workspaceRelativePath: string,
  allowMissing: boolean,
): Promise<string> {
  if (!workspaceRelativePath.trim() || isAbsolute(workspaceRelativePath)) {
    throw new Error(
      "Tool paths must be non-empty and relative to the authorized workspace.",
    );
  }
  const parts = workspaceRelativePath.split(/[\\/]+/);
  if (parts.includes(".."))
    throw new Error("Path traversal outside the workspace is not allowed.");

  const root = await realpath(workspace);
  const candidate = join(root, workspaceRelativePath);
  assertWithin(root, candidate);

  if (!allowMissing) {
    const resolved = await realpath(candidate);
    assertWithin(root, resolved);
    return resolved;
  }

  await rejectSymlinkAncestors(root, candidate);
  let existing = dirname(candidate);
  while (existing !== root) {
    try {
      const resolved = await realpath(existing);
      assertWithin(root, resolved);
      break;
    } catch (error) {
      if (!isMissingPath(error))
        throw new Error("Unable to resolve a safe workspace path.", {
          cause: error,
        });
      const parent = dirname(existing);
      if (parent === existing)
        throw new Error("Unable to resolve a safe workspace path.", {
          cause: error,
        });
      existing = parent;
    }
  }
  return candidate;
}

function assertWithin(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Tool path resolves outside the authorized workspace.");
  }
}

async function rejectSymlinkAncestors(
  root: string,
  candidate: string,
): Promise<void> {
  const relativePath = relative(root, candidate);
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("File writes through symbolic links are not allowed.");
      }
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
