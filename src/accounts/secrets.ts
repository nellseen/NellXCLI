import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export interface SecretStore {
  put(credentialId: string, secret: string): Promise<string>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

interface SecretEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

type SecretEntryFactory = (credentialId: string) => Promise<SecretEntry>;

const EncryptedSecretSchema = z.object({
  salt: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
const VaultSchema = z.object({
  version: z.literal(1),
  items: z.record(z.string(), EncryptedSecretSchema),
});
const SecretReferenceSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("keyring"), credentialId: z.string().uuid() }),
  z.object({ backend: z.literal("vault"), credentialId: z.string().uuid() }),
]);

type SecretReference = z.infer<typeof SecretReferenceSchema>;
type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;
type VaultData = z.infer<typeof VaultSchema>;

export class SystemKeyringStore implements SecretStore {
  constructor(
    private readonly createEntry: SecretEntryFactory = createSystemEntry,
  ) {}

  async put(credentialId: string, secret: string): Promise<string> {
    try {
      const entry = await this.createEntry(credentialId);
      await entry.setPassword(secret);
      return encodeReference({ backend: "keyring", credentialId });
    } catch {
      throw new Error("OS credential store is unavailable or locked.");
    }
  }

  async get(reference: string): Promise<string> {
    const parsed = parseReference(reference, "keyring");
    try {
      const secret = await (
        await this.createEntry(parsed.credentialId)
      ).getPassword();
      if (secret === null)
        throw new Error("Credential is missing from the OS credential store.");
      return secret;
    } catch {
      throw new Error(
        "Unable to read this credential from the OS credential store.",
      );
    }
  }

  async delete(reference: string): Promise<void> {
    const parsed = parseReference(reference, "keyring");
    try {
      await (await this.createEntry(parsed.credentialId)).deletePassword();
    } catch {
      throw new Error(
        "Unable to delete this credential from the OS credential store.",
      );
    }
  }
}

export class EncryptedVaultStore implements SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly passphrase: string,
  ) {
    if (passphrase.length < 12) {
      throw new Error("Vault passphrase must contain at least 12 characters.");
    }
  }

  async put(credentialId: string, secret: string): Promise<string> {
    const vault = await this.readVault();
    vault.items[credentialId] = await encryptSecret(secret, this.passphrase);
    await this.writeVault(vault);
    return encodeReference({ backend: "vault", credentialId });
  }

  async get(reference: string): Promise<string> {
    const parsed = parseReference(reference, "vault");
    const vault = await this.readVault();
    const encrypted = vault.items[parsed.credentialId];
    if (!encrypted)
      throw new Error("Credential is missing from the encrypted vault.");
    return decryptSecret(encrypted, this.passphrase);
  }

  async delete(reference: string): Promise<void> {
    const parsed = parseReference(reference, "vault");
    const vault = await this.readVault();
    delete vault.items[parsed.credentialId];
    await this.writeVault(vault);
  }

  private async readVault(): Promise<VaultData> {
    let text: string | undefined;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, items: {} };
    }
    if (text === undefined) {
      throw new Error("Encrypted credential vault is unreadable or corrupted.");
    }
    try {
      return VaultSchema.parse(JSON.parse(text) as unknown);
    } catch {
      throw new Error("Encrypted credential vault is unreadable or corrupted.");
    }
  }

  private async writeVault(vault: VaultData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, JSON.stringify(vault), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch {
      await rm(temporaryPath, { force: true });
      throw new Error(
        "Unable to securely write the encrypted credential vault.",
      );
    }
  }
}

export class CredentialService implements SecretStore {
  constructor(
    private readonly keyring: SecretStore,
    private readonly vault?: SecretStore,
  ) {}

  async put(credentialId: string, secret: string): Promise<string> {
    try {
      return await this.keyring.put(credentialId, secret);
    } catch {
      if (!this.vault) {
        throw new Error(
          "OS credential store is unavailable. Configure NELLX_VAULT_PASSPHRASE to use the encrypted vault fallback.",
        );
      }
      return this.vault.put(credentialId, secret);
    }
  }

  async get(reference: string): Promise<string> {
    const parsed = decodeReference(reference);
    return parsed.backend === "keyring"
      ? this.keyring.get(reference)
      : this.requireVault().get(reference);
  }

  async delete(reference: string): Promise<void> {
    const parsed = decodeReference(reference);
    if (parsed.backend === "keyring") return this.keyring.delete(reference);
    return this.requireVault().delete(reference);
  }

  private requireVault(): SecretStore {
    if (!this.vault) {
      throw new Error(
        "This credential is stored in the encrypted vault. Configure NELLX_VAULT_PASSPHRASE to access it.",
      );
    }
    return this.vault;
  }
}

export function createCredentialService(
  configDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  keyring?: SecretStore,
): CredentialService {
  const vaultPassphrase = env.NELLX_VAULT_PASSPHRASE;
  const vault = vaultPassphrase
    ? new EncryptedVaultStore(
        `${configDirectory}/credentials.vault`,
        vaultPassphrase,
      )
    : undefined;
  return new CredentialService(keyring ?? new SystemKeyringStore(), vault);
}

function encodeReference(reference: SecretReference): string {
  return JSON.stringify(reference);
}

function decodeReference(reference: string): SecretReference {
  return SecretReferenceSchema.parse(JSON.parse(reference) as unknown);
}

function parseReference(
  reference: string,
  expected: SecretReference["backend"],
): SecretReference {
  const parsed = decodeReference(reference);
  if (parsed.backend !== expected)
    throw new Error("Credential backend mismatch.");
  return parsed;
}

async function createSystemEntry(credentialId: string): Promise<SecretEntry> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const options =
    process.platform === "linux"
      ? { linux: { store: "secret-service" as const } }
      : undefined;
  return new AsyncEntry("nellxcli", credentialId, options);
}

async function encryptSecret(
  secret: string,
  passphrase: string,
): Promise<EncryptedSecret> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function decryptSecret(
  encrypted: EncryptedSecret,
  passphrase: string,
): Promise<string> {
  try {
    const salt = Buffer.from(encrypted.salt, "base64");
    const nonce = Buffer.from(encrypted.nonce, "base64");
    const key = await deriveKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Vault could not decrypt the credential. Check the passphrase and vault file.",
    );
  }
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      32,
      { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
