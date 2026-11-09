import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalDatabase } from "../storage/database.js";
import type { ProviderErrorCategory } from "../providers/provider.js";
import type { SecretStore } from "./secrets.js";

const ProfileInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  userLabel: z.string().trim().max(200).optional(),
  projectId: z.string().trim().min(1).max(200),
  priority: z.number().int().min(-1000).max(1000).default(0),
});
const ApiKeyInputSchema = z.string().trim().min(1).max(4096);
const ProfileUpdateSchema = ProfileInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one profile field must be provided.",
);

export type AccountProfileInput = z.input<typeof ProfileInputSchema>;
export type AccountProfile = z.output<typeof ProfileInputSchema> & {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  credentialCount: number;
};
export type CredentialStatus = "active" | "quarantined" | "disabled";
export interface ApiCredentialInfo {
  id: string;
  accountProfileId: string;
  projectId: string;
  enabled: boolean | number;
  status: CredentialStatus;
  createdAt: string;
  lastUsedAt?: string;
}
export interface ProjectHealthInfo {
  projectId: string;
  model: string;
  status: "healthy" | "cooldown" | "action_required";
  cooldownUntil?: string;
  lastErrorCategory?: ProviderErrorCategory;
  lastSuccessAt?: string;
  updatedAt: string;
}

interface StoredCredential extends ApiCredentialInfo {
  secretReference: string;
}

export class AccountManager {
  constructor(
    private readonly database: LocalDatabase,
    private readonly secrets: SecretStore,
  ) {}

  async addProfile(input: AccountProfileInput): Promise<AccountProfile> {
    const parsed = ProfileInputSchema.parse(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.database.execute(
      `INSERT INTO account_profiles
        (id, display_name, user_label, project_id, enabled, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        parsed.displayName,
        parsed.userLabel ?? null,
        parsed.projectId,
        parsed.priority,
        now,
        now,
      ],
    );
    return this.getProfile(id);
  }

  async updateProfile(
    profileId: string,
    update: Partial<AccountProfileInput>,
  ): Promise<AccountProfile> {
    const parsed = ProfileUpdateSchema.parse(update);
    const current = await this.getProfile(profileId);
    const displayName = parsed.displayName ?? current.displayName;
    const userLabel = parsed.userLabel ?? current.userLabel;
    const projectId = parsed.projectId ?? current.projectId;
    const priority = parsed.priority ?? current.priority;
    const now = new Date().toISOString();
    await this.database.execute(
      `UPDATE account_profiles SET display_name = ?, user_label = ?, project_id = ?,
         priority = ?, updated_at = ? WHERE id = ?`,
      [displayName, userLabel ?? null, projectId, priority, now, profileId],
    );
    await this.database.execute(
      "UPDATE api_credentials SET project_id = ? WHERE account_profile_id = ?",
      [projectId, profileId],
    );
    return this.getProfile(profileId);
  }

  async listProfiles(): Promise<AccountProfile[]> {
    const rows = this.database.query<{
      id: string;
      display_name: string;
      user_label: string | null;
      project_id: string;
      enabled: number;
      priority: number;
      created_at: string;
      updated_at: string;
      credential_count: number;
    }>(
      `SELECT p.id, p.display_name, p.user_label, p.project_id, p.enabled, p.priority,
              p.created_at, p.updated_at, COUNT(c.id) AS credential_count
       FROM account_profiles p LEFT JOIN api_credentials c ON c.account_profile_id = p.id
       GROUP BY p.id ORDER BY p.priority DESC, p.created_at ASC`,
    );
    return rows.map(toProfile);
  }

  async getProfile(profileId: string): Promise<AccountProfile> {
    const profile = (await this.listProfiles()).find(
      (item) => item.id === profileId,
    );
    if (!profile) throw new Error("Account profile was not found.");
    return profile;
  }

  async setProfileEnabled(profileId: string, enabled: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.database.execute(
      "UPDATE account_profiles SET enabled = ?, updated_at = ? WHERE id = ?",
      [enabled ? 1 : 0, now, profileId],
    );
    await this.requireProfileExists(profileId);
  }

  async addApiKey(
    profileId: string,
    apiKey: string,
  ): Promise<ApiCredentialInfo> {
    const credential = ApiKeyInputSchema.parse(apiKey);
    const profile = await this.getProfile(profileId);
    const id = randomUUID();
    const secretReference = await this.secrets.put(id, credential);
    const now = new Date().toISOString();
    try {
      await this.database.execute(
        `INSERT INTO api_credentials
          (id, account_profile_id, project_id, secret_reference, enabled, status, created_at)
         VALUES (?, ?, ?, ?, 1, 'active', ?)`,
        [id, profileId, profile.projectId, secretReference, now],
      );
    } catch (error) {
      try {
        await this.secrets.delete(secretReference);
      } catch {
        throw new Error(
          "Could not save credential metadata or clean up its secret-store entry.",
        );
      }
      throw error;
    }
    return this.getCredential(id);
  }

  async listCredentials(profileId?: string): Promise<ApiCredentialInfo[]> {
    const rows = profileId
      ? this.database.query<StoredCredential>(
          `SELECT id, account_profile_id AS accountProfileId, project_id AS projectId,
                  secret_reference AS secretReference, enabled, status, created_at AS createdAt,
                  last_used_at AS lastUsedAt
           FROM api_credentials WHERE account_profile_id = ? ORDER BY created_at`,
          [profileId],
        )
      : this.database.query<StoredCredential>(
          `SELECT id, account_profile_id AS accountProfileId, project_id AS projectId,
                  secret_reference AS secretReference, enabled, status, created_at AS createdAt,
                  last_used_at AS lastUsedAt
           FROM api_credentials ORDER BY created_at`,
        );
    return rows.map(toCredentialInfo);
  }

  async getCredential(credentialId: string): Promise<ApiCredentialInfo> {
    const row = this.database.queryOne<StoredCredential>(
      `SELECT id, account_profile_id AS accountProfileId, project_id AS projectId,
              secret_reference AS secretReference, enabled, status, created_at AS createdAt,
              last_used_at AS lastUsedAt
       FROM api_credentials WHERE id = ?`,
      [credentialId],
    );
    if (!row) throw new Error("API credential was not found.");
    return toCredentialInfo(row);
  }

  async getApiKey(credentialId: string): Promise<string> {
    const row = this.database.queryOne<StoredCredential>(
      `SELECT id, account_profile_id AS accountProfileId, project_id AS projectId,
              secret_reference AS secretReference, enabled, status, created_at AS createdAt,
              last_used_at AS lastUsedAt
       FROM api_credentials WHERE id = ?`,
      [credentialId],
    );
    if (!row || !row.enabled || row.status !== "active") {
      throw new Error("API credential is unavailable or requires user action.");
    }
    await this.database.execute(
      "UPDATE api_credentials SET last_used_at = ? WHERE id = ?",
      [new Date().toISOString(), credentialId],
    );
    return this.secrets.get(row.secretReference);
  }

  async setCredentialEnabled(
    credentialId: string,
    enabled: boolean,
  ): Promise<void> {
    const result = this.database.queryOne<{ id: string }>(
      "SELECT id FROM api_credentials WHERE id = ?",
      [credentialId],
    );
    if (!result) throw new Error("API credential was not found.");
    await this.database.execute(
      "UPDATE api_credentials SET enabled = ? WHERE id = ?",
      [enabled ? 1 : 0, credentialId],
    );
  }

  async quarantineCredential(credentialId: string): Promise<void> {
    const result = this.database.queryOne<{ id: string }>(
      "SELECT id FROM api_credentials WHERE id = ?",
      [credentialId],
    );
    if (!result) throw new Error("API credential was not found.");
    await this.database.execute(
      "UPDATE api_credentials SET status = 'quarantined', enabled = 0 WHERE id = ?",
      [credentialId],
    );
  }

  async removeCredential(credentialId: string): Promise<void> {
    const row = this.database.queryOne<StoredCredential>(
      `SELECT id, account_profile_id AS accountProfileId, project_id AS projectId,
              secret_reference AS secretReference, enabled, status, created_at AS createdAt,
              last_used_at AS lastUsedAt
       FROM api_credentials WHERE id = ?`,
      [credentialId],
    );
    if (!row) throw new Error("API credential was not found.");
    await this.secrets.delete(row.secretReference);
    await this.database.execute("DELETE FROM api_credentials WHERE id = ?", [
      credentialId,
    ]);
  }

  async removeProfile(profileId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    await this.setProfileEnabled(profile.id, false);
    const credentials = await this.listCredentials(profile.id);
    for (const credential of credentials) {
      await this.removeCredential(credential.id);
    }
    await this.database.execute("DELETE FROM account_profiles WHERE id = ?", [
      profile.id,
    ]);
    await this.database.execute(
      "DELETE FROM settings WHERE key = 'default_account_profile' AND value = ?",
      [profile.id],
    );
  }

  async recordProjectSuccess(projectId: string, model: string): Promise<void> {
    const now = new Date().toISOString();
    await this.database.execute(
      `INSERT INTO project_health (project_id, model, status, last_success_at, updated_at)
       VALUES (?, ?, 'healthy', ?, ?)
       ON CONFLICT(project_id, model) DO UPDATE SET
         status = 'healthy', cooldown_until = NULL, last_error_category = NULL,
         last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
      [projectId, model, now, now],
    );
  }

  async recordProjectFailure(
    projectId: string,
    model: string,
    category: ProviderErrorCategory,
    cooldownUntil?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const actionRequired = category === "permission";
    await this.database.execute(
      `INSERT INTO project_health
        (project_id, model, status, cooldown_until, last_error_category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, model) DO UPDATE SET
         status = excluded.status, cooldown_until = excluded.cooldown_until,
         last_error_category = excluded.last_error_category, updated_at = excluded.updated_at`,
      [
        projectId,
        model,
        actionRequired
          ? "action_required"
          : cooldownUntil
            ? "cooldown"
            : "healthy",
        cooldownUntil ?? null,
        category,
        now,
      ],
    );
  }

  async listProjectHealth(): Promise<ProjectHealthInfo[]> {
    const rows = this.database.query<{
      project_id: string;
      model: string;
      status: ProjectHealthInfo["status"];
      cooldown_until: string | null;
      last_error_category: ProviderErrorCategory | null;
      last_success_at: string | null;
      updated_at: string;
    }>("SELECT * FROM project_health ORDER BY project_id, model");
    return rows.map((row) => ({
      projectId: row.project_id,
      model: row.model,
      status: row.status,
      ...(row.cooldown_until ? { cooldownUntil: row.cooldown_until } : {}),
      ...(row.last_error_category
        ? { lastErrorCategory: row.last_error_category }
        : {}),
      ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
      updatedAt: row.updated_at,
    }));
  }

  async setDefaultProfile(profileId: string): Promise<void> {
    await this.requireProfileExists(profileId);
    await this.database.execute(
      "INSERT INTO settings (key, value) VALUES ('default_account_profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [profileId],
    );
  }

  getDefaultProfileId(): string | undefined {
    return this.database.queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'default_account_profile'",
    )?.value;
  }

  async getDefaultApiKey(): Promise<string> {
    const profileId = this.getDefaultProfileId();
    if (!profileId)
      throw new Error(
        'No default account selected. Run "nellx accounts select".',
      );
    const profile = await this.getProfile(profileId);
    if (!profile.enabled)
      throw new Error(
        "The selected account is disabled. Choose another account.",
      );
    const credential = (await this.listCredentials(profileId)).find(
      (item) => item.enabled && item.status === "active",
    );
    if (!credential)
      throw new Error(
        "The selected account has no active API key. Add a key or choose another account.",
      );
    return this.getApiKey(credential.id);
  }

  async getEligibleProjectIds(
    model: string,
    now = new Date(),
  ): Promise<string[]> {
    const profiles = (await this.listProfiles()).filter(
      (profile) => profile.enabled,
    );
    const enabledProfileIds = new Set(profiles.map((profile) => profile.id));
    const credentials = await this.listCredentials();
    const projectIds = new Set(
      credentials
        .filter(
          (credential) =>
            credential.enabled &&
            credential.status === "active" &&
            enabledProfileIds.has(credential.accountProfileId),
        )
        .map((credential) => credential.projectId),
    );
    const health = this.database.query<{
      project_id: string;
      status: ProjectHealthInfo["status"];
      cooldown_until: string | null;
    }>(
      "SELECT project_id, status, cooldown_until FROM project_health WHERE model = ?",
      [model],
    );
    const excluded = new Set(
      health
        .filter(
          (item) =>
            item.status === "action_required" ||
            (item.status === "cooldown" &&
              item.cooldown_until &&
              new Date(item.cooldown_until) > now),
        )
        .map((item) => item.project_id),
    );
    return [...projectIds].filter(
      (projectId) =>
        profiles.some((profile) => profile.projectId === projectId) &&
        !excluded.has(projectId),
    );
  }

  private async requireProfileExists(profileId: string): Promise<void> {
    if (
      !this.database.queryOne("SELECT id FROM account_profiles WHERE id = ?", [
        profileId,
      ])
    ) {
      throw new Error("Account profile was not found.");
    }
  }
}

function toProfile(row: {
  id: string;
  display_name: string;
  user_label: string | null;
  project_id: string;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
  credential_count: number;
}): AccountProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    ...(row.user_label ? { userLabel: row.user_label } : {}),
    projectId: row.project_id,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialCount: row.credential_count,
  };
}

function toCredentialInfo(row: StoredCredential): ApiCredentialInfo {
  return {
    id: row.id,
    accountProfileId: row.accountProfileId,
    projectId: row.projectId,
    enabled: row.enabled === 1 || row.enabled === true,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
  };
}
