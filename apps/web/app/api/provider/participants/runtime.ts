import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  ParticipantLifecycleStore,
} from "./lifecycle-store";
import type {
  ParticipantLifecycleDependencies,
  ProviderParticipant,
} from "./service";

function store(): ParticipantLifecycleStore {
  const database = protocolDatabase();
  const secret = process.env.ACCESS_SESSION_SECRET;
  if (!database || !secret) {
    throw Object.assign(new Error("Participant lifecycle runtime unavailable"), {
      code: "PARTICIPANT_LIFECYCLE_UNAVAILABLE",
    });
  }
  return new ParticipantLifecycleStore(database, secret);
}

export function participantLifecycleDependencies():
ParticipantLifecycleDependencies {
  return Object.freeze({
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    list: () => store().list(),
    preview: (selector, operation) => store().preview(selector, operation),
    confirm: (confirmationLocator) => store().confirm(confirmationLocator),
  });
}

export function listProviderParticipants():
Promise<readonly ProviderParticipant[]> {
  return store().list();
}
