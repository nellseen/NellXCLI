import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceImage } from "../../src/providers/image-input.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("workspace image input", () => {
  it("loads and base64-encodes a workspace raster image", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-image-"));
    roots.push(workspace);
    await writeFile(
      join(workspace, "picture.png"),
      Buffer.from("89504e470d0a1a0a", "hex"),
    );
    await expect(loadWorkspaceImage(workspace, "picture.png")).resolves.toEqual(
      {
        mimeType: "image/png",
        data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      },
    );
  });

  it("rejects unsupported extensions and paths escaping workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-image-"));
    roots.push(workspace);
    await writeFile(join(workspace, "picture.svg"), "<svg />");
    await writeFile(join(workspace, "fake.png"), "not png");
    await expect(loadWorkspaceImage(workspace, "picture.svg")).rejects.toThrow(
      /PNG, JPEG/,
    );
    await expect(
      loadWorkspaceImage(workspace, "../picture.png"),
    ).rejects.toThrow();
    await expect(loadWorkspaceImage(workspace, "fake.png")).rejects.toThrow(
      /do not match/,
    );
  });

  it("rejects empty or oversized attachments", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-image-"));
    roots.push(workspace);
    await writeFile(join(workspace, "empty.png"), "");
    await expect(loadWorkspaceImage(workspace, "empty.png")).rejects.toThrow(
      /regular file between 1 byte and 4 MB|between 1 byte and 4 MB/,
    );
    await writeFile(
      join(workspace, "large.png"),
      Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.alloc(4_000_001 - 8),
      ]),
    );
    await expect(loadWorkspaceImage(workspace, "large.png")).rejects.toThrow(
      /regular file between 1 byte and 4 MB|between 1 byte and 4 MB/,
    );
  });
});
