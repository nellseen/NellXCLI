import { open } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../tools/path-guard.js";
import type { ImageAttachment } from "./provider.js";

const imageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
} as const;
const MAX_IMAGE_BYTES = 4_000_000;

export async function loadWorkspaceImage(
  workspace: string,
  relativePath: string,
): Promise<ImageAttachment> {
  const path = z.string().min(1).max(1000).parse(relativePath);
  const mimeType =
    imageTypes[extname(path).toLowerCase() as keyof typeof imageTypes];
  if (!mimeType) throw new Error("Image must be PNG, JPEG, WebP, or GIF.");
  const file = await resolveWorkspacePath(workspace, path, false);
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES)
      throw new Error("Image must be a regular file between 1 byte and 4 MB.");
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead === 0 || bytesRead > MAX_IMAGE_BYTES)
      throw new Error("Image must be between 1 byte and 4 MB.");
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!hasImageSignature(bytes, mimeType))
    throw new Error("Image contents do not match the file extension.");
  return { mimeType, data: bytes.toString("base64") };
}

function hasImageSignature(
  bytes: Buffer,
  mimeType: ImageAttachment["mimeType"],
): boolean {
  switch (mimeType) {
    case "image/png":
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return (
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
  }
}
