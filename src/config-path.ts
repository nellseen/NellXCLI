import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ConfigPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function getConfigDirectory(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();

  if (platform === "win32") {
    const path = win32;
    const appData = env.APPDATA;
    return path.join(
      appData || path.join(homeDir, "AppData", "Roaming"),
      "nellx",
    );
  }

  const path = posix;
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "nellx");
  }

  return path.join(
    env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
    "nellx",
  );
}
