import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { getConfigDirectory } from "../config-path.js";
import { LocalDatabase } from "./database.js";

export async function openDefaultDatabase(): Promise<LocalDatabase> {
  const configDirectory = getConfigDirectory();
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  return LocalDatabase.open(join(configDirectory, "nellx.sqlite"));
}

export { getConfigDirectory };
