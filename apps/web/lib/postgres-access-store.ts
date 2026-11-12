import { randomInt, randomUUID } from "node:crypto";
import {
  AccessError,
  AccessSessionCodec,
} from "@scopeledger/access";
import type {
  AccessRole,
  AccessSession,
  IssuedChallenge,
} from "@scopeledger/access";
import {
  PostgresAccessChallengeStore,
  RuntimePersistenceError,
} from "@scopeledger/db";
import type { ProtocolDatabase } from "@scopeledger/db";

type Scope = Readonly<{
  workspaceId: string;
  projectId: string;
}>;

function mapPersistenceError(error: unknown): never {
  if (!(error instanceof RuntimePersistenceError)) throw error;
  const mapped = {
    INVALID_INPUT: "INVALID_INPUT",
    NOT_FOUND: "NOT_FOUND",
    CHALLENGE_EXPIRED: "EXPIRED",
    CHALLENGE_SUPERSEDED: "SUPERSEDED",
    CHALLENGE_ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED",
    CHALLENGE_CODE_MISMATCH: "CODE_MISMATCH",
    CHALLENGE_ALREADY_VERIFIED: "ALREADY_VERIFIED",
    CHALLENGE_RATE_LIMITED: "RATE_LIMITED",
  } as const;
  const code = error.code in mapped
    ? mapped[error.code as keyof typeof mapped]
    : "STORAGE_FAILED";
  throw new AccessError(code, "PostgreSQL access challenge failed safely");
}

export class PostgresLocalAccessStore {
  private readonly persistence: PostgresAccessChallengeStore;
  private readonly codec: AccessSessionCodec;
  private readonly clock: () => Date;
  private readonly codeGenerator: () => string;

  constructor(
    database: ProtocolDatabase,
    private readonly scope: Scope,
    secret: string,
    options: {
      clock?: () => Date;
      codeGenerator?: () => string;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.codeGenerator = options.codeGenerator
      ?? (() => randomInt(0, 1_000_000).toString().padStart(6, "0"));
    this.persistence = new PostgresAccessChallengeStore(database, {
      clock: this.clock,
    });
    this.codec = new AccessSessionCodec(secret, { clock: this.clock });
  }

  async issue(input: {
    recipient: string;
    role: AccessRole;
  }): Promise<IssuedChallenge> {
    const challengeId = randomUUID();
    const code = this.codeGenerator();
    if (!/^[0-9]{6}$/.test(code)) {
      throw new AccessError(
        "INVALID_CONFIG",
        "Access code generator returned an invalid code",
      );
    }
    const expiresAt = new Date(this.clock().getTime() + 10 * 60_000);
    try {
      const record = await this.persistence.issue({
        ...this.scope,
        challengeId,
        recipientReference: input.recipient,
        role: input.role,
        codeDigest: this.codec.codeDigest(challengeId, code),
        expiresAt,
      });
      return Object.freeze({
        challengeId: record.challengeId,
        code,
        recipient: record.recipientReference,
        role: record.role,
        expiresAt: record.expiresAt.toISOString(),
      });
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async revoke(challengeId: string): Promise<void> {
    try {
      await this.persistence.supersede({
        ...this.scope,
        challengeId,
      });
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async verify(input: {
    challengeId: string;
    code: string;
  }): Promise<AccessSession> {
    try {
      const record = await this.persistence.verify({
        ...this.scope,
        challengeId: input.challengeId,
        candidateCodeDigest: this.codec.codeDigest(
          input.challengeId,
          input.code,
        ),
      });
      const verifiedAt = record.verifiedAt ?? this.clock();
      return Object.freeze({
        schemaVersion: 1,
        subject: this.codec.subject(record.recipientReference, record.role),
        role: record.role,
        challengeId: record.challengeId,
        verifiedAt: verifiedAt.toISOString(),
        expiresAt: new Date(
          verifiedAt.getTime() + 30 * 60_000,
        ).toISOString(),
      });
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  mintSession(session: AccessSession): string {
    return this.codec.mintSession(session);
  }

  readSession(token: string | undefined): AccessSession | null {
    return this.codec.readSession(token);
  }
}
