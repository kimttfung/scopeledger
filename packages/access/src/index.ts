import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export type AccessErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "EXPIRED"
  | "SUPERSEDED"
  | "ATTEMPTS_EXHAUSTED"
  | "CODE_MISMATCH"
  | "ALREADY_VERIFIED"
  | "RATE_LIMITED"
  | "STORAGE_FAILED"
  | "SESSION_INVALID";

export class AccessError extends Error {
  constructor(
    public readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

const localRecipient = z.email().refine(
  (value) => value.toLowerCase().endsWith("@scopeledger.test"),
  "Local access recipients must use scopeledger.test",
);
const roleSchema = z.enum(["client-approver", "payer"]);
const secretSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const challengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  challengeId: z.uuid(),
  recipient: localRecipient,
  role: roleSchema,
  codeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  attempts: z.number().int().min(0).max(5),
  status: z.enum(["active", "verified", "superseded"]),
  verifiedAt: z.iso.datetime().nullable(),
});

type Challenge = z.infer<typeof challengeSchema>;

const sessionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subject: z.string().regex(/^[a-f0-9]{64}$/),
  role: roleSchema,
  challengeId: z.uuid(),
  verifiedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type AccessRole = z.infer<typeof roleSchema>;
export type AccessSession = Readonly<z.infer<typeof sessionPayloadSchema>>;

export type IssuedChallenge = Readonly<{
  challengeId: string;
  code: string;
  recipient: string;
  role: AccessRole;
  expiresAt: string;
}>;

type AccessStoreOptions = {
  rootDirectory: string;
  secret: string;
  clock?: () => Date;
  codeGenerator?: () => string;
};

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function parseBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export class FileAccessStore {
  private readonly root: string;
  private readonly secret: string;
  private readonly clock: () => Date;
  private readonly codeGenerator: () => string;

  constructor(options: AccessStoreOptions) {
    const secret = secretSchema.safeParse(options.secret);
    if (!secret.success) {
      throw new AccessError(
        "INVALID_CONFIG",
        "Access session secret must be a 32-byte hexadecimal value",
      );
    }
    this.root = resolve(options.rootDirectory);
    this.secret = secret.data.toLowerCase();
    this.clock = options.clock ?? (() => new Date());
    this.codeGenerator = options.codeGenerator
      ?? (() => randomInt(0, 1_000_000).toString().padStart(6, "0"));
  }

  async issue(input: unknown): Promise<IssuedChallenge> {
    const parsed = z.strictObject({
      recipient: localRecipient,
      role: roleSchema,
    }).safeParse(input);
    if (!parsed.success) {
      throw new AccessError("INVALID_INPUT", "Access challenge input is invalid");
    }
    return this.withLock("issue", async () => {
      await this.ensureRoot();
      const now = this.clock();
      const recent = await this.recentChallenges(
        parsed.data.recipient,
        parsed.data.role,
        now,
      );
      if (recent.length >= 3) {
        throw new AccessError(
          "RATE_LIMITED",
          "Too many recent local verification requests",
        );
      }
      for (const challenge of recent.filter((row) => row.status === "active")) {
        await this.writeChallenge({
          ...challenge,
          status: "superseded",
        });
      }
      const challengeId = randomUUID();
      const code = this.codeGenerator();
      if (!/^[0-9]{6}$/.test(code)) {
        throw new AccessError("INVALID_CONFIG", "Access code generator returned an invalid code");
      }
      const expiresAt = new Date(now.getTime() + 10 * 60_000);
      const challenge: Challenge = {
        schemaVersion: 1,
        challengeId,
        recipient: parsed.data.recipient,
        role: parsed.data.role,
        codeDigest: this.codeDigest(challengeId, code),
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        attempts: 0,
        status: "active",
        verifiedAt: null,
      };
      await this.writeChallenge(challenge);
      return Object.freeze({
        challengeId,
        code,
        recipient: challenge.recipient,
        role: challenge.role,
        expiresAt: challenge.expiresAt,
      });
    });
  }

  async revoke(challengeIdInput: unknown): Promise<void> {
    const challengeId = this.challengeId(challengeIdInput);
    await this.withLock(challengeId, async () => {
      const challenge = await this.readChallenge(challengeId);
      if (challenge.status === "active") {
        await this.writeChallenge({ ...challenge, status: "superseded" });
      }
    });
  }

  async verify(input: unknown): Promise<AccessSession> {
    const parsed = z.strictObject({
      challengeId: z.uuid(),
      code: z.string().regex(/^[0-9]{6}$/),
    }).safeParse(input);
    if (!parsed.success) {
      throw new AccessError("INVALID_INPUT", "Verification input is invalid");
    }
    return this.withLock(parsed.data.challengeId, async () => {
      const challenge = await this.readChallenge(parsed.data.challengeId);
      const now = this.clock();
      if (challenge.status === "verified") {
        throw new AccessError("ALREADY_VERIFIED", "Challenge was already verified");
      }
      if (challenge.status === "superseded") {
        throw new AccessError("SUPERSEDED", "Challenge was replaced by a newer request");
      }
      if (Date.parse(challenge.expiresAt) <= now.getTime()) {
        throw new AccessError("EXPIRED", "Challenge expired");
      }
      if (challenge.attempts >= 5) {
        throw new AccessError("ATTEMPTS_EXHAUSTED", "Challenge attempts are exhausted");
      }
      const expected = this.codeDigest(challenge.challengeId, parsed.data.code);
      if (!safeEqual(expected, challenge.codeDigest)) {
        const attempts = challenge.attempts + 1;
        await this.writeChallenge({ ...challenge, attempts });
        throw new AccessError(
          attempts >= 5 ? "ATTEMPTS_EXHAUSTED" : "CODE_MISMATCH",
          "Verification code did not match",
        );
      }
      const verifiedAt = now.toISOString();
      await this.writeChallenge({
        ...challenge,
        status: "verified",
        verifiedAt,
      });
      return Object.freeze({
        schemaVersion: 1,
        subject: this.subject(challenge.recipient, challenge.role),
        role: challenge.role,
        challengeId: challenge.challengeId,
        verifiedAt,
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      });
    });
  }

  mintSession(sessionInput: AccessSession): string {
    const session = sessionPayloadSchema.parse(sessionInput);
    const payload = base64Url(JSON.stringify(session));
    const signature = createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  readSession(token: string | undefined): AccessSession | null {
    if (!token) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
    if (!safeEqual(expected, signature)) return null;
    try {
      const parsed = sessionPayloadSchema.safeParse(
        JSON.parse(parseBase64Url(payload)),
      );
      if (!parsed.success || Date.parse(parsed.data.expiresAt) <= this.clock().getTime()) {
        return null;
      }
      return Object.freeze(parsed.data);
    } catch {
      return null;
    }
  }

  private challengeId(input: unknown): string {
    const parsed = z.uuid().safeParse(input);
    if (!parsed.success) throw new AccessError("INVALID_INPUT", "Challenge ID is invalid");
    return parsed.data;
  }

  private subject(recipient: string, role: AccessRole): string {
    return createHmac("sha256", this.secret)
      .update(`${role}:${recipient.toLowerCase()}`)
      .digest("hex");
  }

  private codeDigest(challengeId: string, code: string): string {
    return createHmac("sha256", this.secret)
      .update(`${challengeId}:${code}`)
      .digest("hex");
  }

  private challengePath(challengeId: string): string {
    const path = resolve(this.root, `${challengeId}.json`);
    if (!path.startsWith(`${this.root}/`)) {
      throw new AccessError("STORAGE_FAILED", "Challenge path escaped its store");
    }
    return path;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  private async readChallenge(challengeId: string): Promise<Challenge> {
    try {
      const parsed = challengeSchema.safeParse(JSON.parse(
        await readFile(this.challengePath(challengeId), "utf8"),
      ));
      if (!parsed.success) throw new Error("invalid");
      return parsed.data;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new AccessError("NOT_FOUND", "Challenge was not found");
      }
      if (error instanceof AccessError) throw error;
      throw new AccessError("STORAGE_FAILED", "Challenge could not be read");
    }
  }

  private async writeChallenge(challengeInput: Challenge): Promise<void> {
    const challenge = challengeSchema.parse(challengeInput);
    await this.ensureRoot();
    const path = this.challengePath(challenge.challengeId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(challenge)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true });
      throw new AccessError("STORAGE_FAILED", "Challenge could not be stored");
    }
  }

  private async recentChallenges(
    recipient: string,
    role: AccessRole,
    now: Date,
  ): Promise<Challenge[]> {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.root).catch(() => []);
    const challenges: Challenge[] = [];
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
      try {
        const parsed = challengeSchema.safeParse(JSON.parse(
          await readFile(resolve(this.root, file), "utf8"),
        ));
        if (
          parsed.success
          && parsed.data.recipient === recipient
          && parsed.data.role === role
          && Date.parse(parsed.data.issuedAt) > now.getTime() - 10 * 60_000
        ) {
          challenges.push(parsed.data);
        }
      } catch {
        // A corrupt unrelated file never becomes a valid challenge.
      }
    }
    return challenges;
  }

  private async withLock<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.ensureRoot();
    const lockPath = resolve(this.root, `${key}.lock`);
    let handle;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
          throw new AccessError("STORAGE_FAILED", "Challenge lock could not be created");
        }
        await delay(50);
      }
    }
    if (!handle) throw new AccessError("STORAGE_FAILED", "Challenge lock timed out");
    try {
      return await work();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
