import { describe, expect, it } from "vitest";
import { getConfigDirectory } from "../src/config-path.js";

describe("getConfigDirectory", () => {
  it("uses APPDATA on Windows", () => {
    expect(
      getConfigDirectory({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
        homeDir: "C:\\Users\\dev",
      }),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\nellx");
  });

  it("uses the macOS Application Support directory", () => {
    expect(
      getConfigDirectory({
        platform: "darwin",
        env: {},
        homeDir: "/Users/dev",
      }),
    ).toBe("/Users/dev/Library/Application Support/nellx");
  });

  it("respects XDG_CONFIG_HOME on Linux", () => {
    expect(
      getConfigDirectory({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/config" },
        homeDir: "/home/dev",
      }),
    ).toBe("/tmp/config/nellx");
  });

  it("uses the Linux default when XDG_CONFIG_HOME is unset", () => {
    expect(
      getConfigDirectory({ platform: "linux", env: {}, homeDir: "/home/dev" }),
    ).toBe("/home/dev/.config/nellx");
  });
});
