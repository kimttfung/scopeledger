import {
  FileAccessStore,
} from "@scopeledger/access";
import type {
  AccessRole,
  AccessSession,
  IssuedChallenge,
} from "@scopeledger/access";
import {
  MailpitEmailClient,
  localEmailConfigFromEnvironment,
} from "@scopeledger/email-adapter";
import { PostgresLocalAccessStore } from "./postgres-access-store";
import { protocolDatabase } from "./protocol-database";

const cookieNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export type LocalAccessRuntime = Readonly<{
  store: LocalAccessStore;
  email: MailpitEmailClient;
  cookieName: string;
  clientRecipient: string;
  payerRecipient: string;
  inboxUrl: string;
  cookieSecure: boolean;
}>;

export type LocalAccessStore = Readonly<{
  issue(input: {
    recipient: string;
    role: AccessRole;
  }): Promise<IssuedChallenge>;
  revoke(challengeId: string): Promise<void>;
  verify(input: {
    challengeId: string;
    code: string;
  }): Promise<AccessSession>;
  mintSession(session: AccessSession): string;
  readSession(token: string | undefined): AccessSession | null;
}>;

export function localAccessRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAccessRuntime | null {
  const secret = environment.ACCESS_SESSION_SECRET;
  const rootDirectory = environment.ACCESS_CHALLENGE_DIR;
  const cookieName = environment.ACCESS_COOKIE_NAME;
  const clientRecipient = environment.EMAIL_DEMO_RECIPIENT;
  const payerRecipient = environment.EMAIL_DEMO_PAYER_RECIPIENT;
  const inboxUrl = environment.EMAIL_MAILPIT_API;
  const appBaseUrl = environment.APP_BASE_URL;
  if (
    !secret
    || !rootDirectory
    || !cookieName
    || !clientRecipient
    || !payerRecipient
    || !inboxUrl
    || !appBaseUrl
  ) {
    return null;
  }
  if (!cookieNamePattern.test(cookieName)) {
    throw new Error("ACCESS_COOKIE_NAME is invalid");
  }
  const inbox = new URL(inboxUrl);
  if (
    inbox.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(inbox.hostname)
  ) {
    throw new Error("EMAIL_MAILPIT_API must use local loopback HTTP");
  }
  const database = protocolDatabase();
  return Object.freeze({
    store: database
      ? new PostgresLocalAccessStore(
        database,
        {
          workspaceId: "demo-workspace",
          projectId: "cedar-roastery",
        },
        secret,
      )
      : new FileAccessStore({ rootDirectory, secret }),
    email: new MailpitEmailClient(localEmailConfigFromEnvironment(environment)),
    cookieName,
    clientRecipient,
    payerRecipient,
    inboxUrl: inbox.origin,
    cookieSecure: new URL(appBaseUrl).protocol === "https:",
  });
}

export function requireSameOrigin(request: Request): void {
  const originValue = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")
    ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto")
    ?? new URL(request.url).protocol.replace(":", "");
  if (!originValue || !host) {
    throw new Error("SAME_ORIGIN_REQUIRED");
  }
  const origin = new URL(originValue);
  if (origin.host !== host || origin.protocol !== `${protocol}:`) {
    throw new Error("SAME_ORIGIN_REQUIRED");
  }
}
