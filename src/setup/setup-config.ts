import { z } from "zod";
import type { LocalDatabase } from "../storage/database.js";

const SettingSchema = z.string();

export interface SetupPreferences {
  defaultProfileId?: string;
  defaultModel?: string;
  defaultWorkspace?: string;
}

export class SetupConfig {
  constructor(private readonly database: LocalDatabase) {}

  get(): SetupPreferences {
    const values = new Map(
      this.database
        .query<{ key: string; value: string }>(
          "SELECT key, value FROM settings WHERE key IN (?, ?, ?)",
          ["default_model", "default_workspace", "default_account_profile"],
        )
        .map(({ key, value }) => [key, SettingSchema.parse(value)]),
    );
    const defaultProfileId = values.get("default_account_profile");
    const defaultModel = values.get("default_model");
    const defaultWorkspace = values.get("default_workspace");
    return {
      ...(defaultProfileId ? { defaultProfileId } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultWorkspace ? { defaultWorkspace } : {}),
    };
  }

  async save(preferences: Required<SetupPreferences>): Promise<void> {
    await this.database.transaction(async (database) => {
      for (const [key, value] of Object.entries({
        default_account_profile: preferences.defaultProfileId,
        default_model: preferences.defaultModel,
        default_workspace: preferences.defaultWorkspace,
      })) {
        await database.execute(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [key, value],
        );
      }
    });
  }
}
