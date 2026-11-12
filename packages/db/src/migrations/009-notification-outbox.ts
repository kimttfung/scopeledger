/** Reviewed PostgreSQL SQL. Adds a bounded, template-safe notification outbox. */
export const migration009 = `
CREATE FUNCTION notification_json_keys_exact(
  payload jsonb,
  expected text[]
) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(payload) = 'object'
    AND (
      SELECT coalesce(array_agg(key ORDER BY key),ARRAY[]::text[])
      FROM jsonb_object_keys(payload) AS key
    ) = (
      SELECT coalesce(array_agg(value ORDER BY value),ARRAY[]::text[])
      FROM unnest(expected) AS value
    )
$$;

CREATE FUNCTION notification_payload_is_safe(
  purpose text,
  payload jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  identifier_pattern constant text :=
    '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$';
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  positive_integer_pattern constant text := '^[1-9][0-9]{0,8}$';
BEGIN
  IF jsonb_typeof(payload) <> 'object'
    OR octet_length(payload::text) > 4096 THEN
    RETURN false;
  END IF;

  CASE purpose
    WHEN 'client-question-submitted' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY['questionId','requestId','unitId','unitVersion']
        )
        AND payload->>'questionId' ~ uuid_pattern
        AND payload->>'requestId' ~ identifier_pattern
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'unitVersion') = 'number'
        AND payload->>'unitVersion' ~ positive_integer_pattern;
    WHEN 'client-correction-submitted' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY['concernId','requestId','unitId','unitVersion']
        )
        AND payload->>'concernId' ~ identifier_pattern
        AND payload->>'requestId' ~ identifier_pattern
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'unitVersion') = 'number'
        AND payload->>'unitVersion' ~ positive_integer_pattern;
    WHEN 'provider-question-responded' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY[
            'questionId','responseRevision','status','unitId','unitVersion'
          ]
        )
        AND payload->>'questionId' ~ uuid_pattern
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'unitVersion') = 'number'
        AND payload->>'unitVersion' ~ positive_integer_pattern
        AND jsonb_typeof(payload->'responseRevision') = 'number'
        AND payload->>'responseRevision' ~ positive_integer_pattern
        AND payload->>'status' IN (
          'answered','needs-client-information','closed'
        );
    WHEN 'provider-correction-assessed' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY[
            'applicability','assessmentRevision','concernId',
            'reissueDraftRevision','unitId','unitVersion'
          ]
        )
        AND payload->>'concernId' ~ identifier_pattern
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'unitVersion') = 'number'
        AND payload->>'unitVersion' ~ positive_integer_pattern
        AND jsonb_typeof(payload->'assessmentRevision') = 'number'
        AND payload->>'assessmentRevision' ~ positive_integer_pattern
        AND payload->>'applicability' IN (
          'no-material-change','material-change','needs-information'
        )
        AND (
          jsonb_typeof(payload->'reissueDraftRevision') = 'null'
          OR (
            jsonb_typeof(payload->'reissueDraftRevision') = 'number'
            AND payload->>'reissueDraftRevision' ~ positive_integer_pattern
          )
        );
    WHEN 'provider-reissue-published' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY['previousVersion','unitId','version']
        )
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'version') = 'number'
        AND payload->>'version' ~ positive_integer_pattern
        AND jsonb_typeof(payload->'previousVersion') = 'number'
        AND payload->>'previousVersion' ~ positive_integer_pattern;
    WHEN 'participant-authority-activated',
         'participant-authority-revoked',
         'participant-authority-restored' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY[
            'authorityEpoch','change','resourceId','role','unitId','version'
          ]
        )
        AND payload->>'role' IN ('client-approver','payer')
        AND payload->>'change' IN ('activated','revoked','restored')
        AND payload->>'resourceId' ~ identifier_pattern
        AND jsonb_typeof(payload->'authorityEpoch') = 'number'
        AND payload->>'authorityEpoch' ~ positive_integer_pattern
        AND (
          (
            payload->>'role' = 'client-approver'
            AND jsonb_typeof(payload->'unitId') = 'null'
            AND jsonb_typeof(payload->'version') = 'null'
          )
          OR (
            payload->>'role' = 'payer'
            AND payload->>'unitId' ~ identifier_pattern
            AND jsonb_typeof(payload->'version') = 'number'
            AND payload->>'version' ~ positive_integer_pattern
          )
        );
    WHEN 'payment-exception-observed' THEN
      RETURN notification_json_keys_exact(
          payload,ARRAY[
            'kind','observationSequence','state','unitId','version'
          ]
        )
        AND payload->>'unitId' ~ identifier_pattern
        AND jsonb_typeof(payload->'version') = 'number'
        AND payload->>'version' ~ positive_integer_pattern
        AND payload->>'kind' IN ('refund','capture-reversal')
        AND payload->>'state' IN (
          'pending','partial-refund','full-refund','failed',
          'reversed','unknown','mismatch'
        )
        AND jsonb_typeof(payload->'observationSequence') = 'number'
        AND payload->>'observationSequence' ~ '^[1-9][0-9]{0,18}$';
    ELSE
      RETURN false;
  END CASE;
END $$;

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  purpose text NOT NULL CHECK (
    purpose IN (
      'client-question-submitted',
      'client-correction-submitted',
      'provider-question-responded',
      'provider-correction-assessed',
      'provider-reissue-published',
      'participant-authority-activated',
      'participant-authority-revoked',
      'participant-authority-restored',
      'payment-exception-observed'
    )
  ),
  recipient_role text NOT NULL CHECK (
    recipient_role IN ('provider','client-approver','payer')
  ),
  attributed_actor_id text NOT NULL CHECK (
    attributed_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  source_kind text NOT NULL CHECK (
    source_kind IN (
      'client-question',
      'client-correction',
      'provider-question-response',
      'provider-correction-assessment',
      'provider-publication',
      'participant-history',
      'payment-exception-history'
    )
  ),
  source_key text NOT NULL CHECK (
    source_key ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$'
  ),
  dedupe_key text NOT NULL CHECK (
    dedupe_key ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$'
  ),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending','leased','retry','delivered',
      'suppressed','obsolete','manual'
    )
  ),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (
    max_attempts BETWEEN 1 AND 8
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND max_attempts
  ),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  enqueued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_token uuid,
  lease_owner text CHECK (
    lease_owner IS NULL
    OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
  ),
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  delivered_at timestamptz,
  terminal_at timestamptz,
  UNIQUE (
    workspace_id,project_id,purpose,recipient_role,dedupe_key
  ),
  FOREIGN KEY (workspace_id,project_id)
    REFERENCES projects(workspace_id,id),
  CHECK (notification_payload_is_safe(purpose,payload)),
  CHECK (available_at >= enqueued_at),
  CHECK (
    (status = 'leased')
    = (
      lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CHECK (
    (
      status IN ('delivered','suppressed','obsolete','manual')
    ) = (terminal_at IS NOT NULL)
  )
);

CREATE TABLE notification_delivery_attempts (
  notification_id uuid NOT NULL
    REFERENCES notification_outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  lease_token uuid NOT NULL,
  worker_id text NOT NULL CHECK (
    worker_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
  ),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text CHECK (
    outcome IS NULL
    OR outcome IN (
      'delivered','recovered','retry','suppressed',
      'obsolete','manual','lease-expired'
    )
  ),
  error_code text CHECK (
    error_code IS NULL
    OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  PRIMARY KEY (notification_id,attempt_number),
  UNIQUE (lease_token),
  CHECK (
    (completed_at IS NULL AND outcome IS NULL AND error_code IS NULL)
    OR (completed_at IS NOT NULL AND outcome IS NOT NULL)
  )
);

CREATE TABLE notification_delivery_receipts (
  notification_id uuid PRIMARY KEY
    REFERENCES notification_outbox(id),
  message_id uuid NOT NULL UNIQUE,
  transport text NOT NULL CHECK (transport = 'mailpit'),
  status text NOT NULL CHECK (status IN ('reserved','delivered')),
  reserved_at timestamptz NOT NULL,
  delivered_at timestamptz,
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX notification_outbox_ready
  ON notification_outbox(available_at,enqueued_at,id)
  WHERE status IN ('pending','retry');
CREATE INDEX notification_outbox_expired_leases
  ON notification_outbox(lease_expires_at,id)
  WHERE status = 'leased';
CREATE INDEX notification_outbox_project_status
  ON notification_outbox(workspace_id,project_id,status,enqueued_at);

CREATE FUNCTION protect_notification_outbox_basis() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role
    OR NEW.attributed_actor_id IS DISTINCT FROM OLD.attributed_actor_id
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at
    OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'notification intent basis cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_notification_outbox_basis
  BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION protect_notification_outbox_basis();

CREATE FUNCTION protect_notification_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
    OR NEW.notification_id IS DISTINCT FROM OLD.notification_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
    OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.completed_at IS NULL
    OR NEW.outcome IS NULL THEN
    RAISE EXCEPTION 'notification attempt cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_notification_attempt
  BEFORE UPDATE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_notification_attempt();

CREATE FUNCTION protect_notification_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
    OR NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.transport IS DISTINCT FROM OLD.transport
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR OLD.status = 'delivered'
    OR NEW.status <> 'delivered'
    OR NEW.delivered_at IS NULL THEN
    RAISE EXCEPTION 'notification receipt cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_notification_receipt
  BEFORE UPDATE ON notification_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_notification_receipt();

CREATE TRIGGER durable_notification_outbox
  BEFORE DELETE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER durable_notification_attempt
  BEFORE DELETE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER durable_notification_receipt
  BEFORE DELETE ON notification_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE FUNCTION enqueue_notification_intent(
  intent_workspace_id text,
  intent_project_id text,
  intent_purpose text,
  intent_recipient_role text,
  intent_actor_id text,
  intent_source_kind text,
  intent_source_key text,
  intent_dedupe_key text,
  intent_payload jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_outbox(
    id,workspace_id,project_id,purpose,recipient_role,
    attributed_actor_id,source_kind,source_key,dedupe_key,payload
  ) VALUES (
    gen_random_uuid(),intent_workspace_id,intent_project_id,intent_purpose,
    intent_recipient_role,intent_actor_id,intent_source_kind,
    intent_source_key,intent_dedupe_key,intent_payload
  )
  ON CONFLICT (
    workspace_id,project_id,purpose,recipient_role,dedupe_key
  ) DO NOTHING;
END $$;

CREATE FUNCTION notify_client_question() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_notification_intent(
    NEW.workspace_id,NEW.project_id,'client-question-submitted','provider',
    NEW.asked_by,'client-question',NEW.question_id::text,
    'client-question:' || NEW.question_id::text,
    jsonb_build_object(
      'questionId',NEW.question_id::text,
      'requestId',NEW.request_id,
      'unitId',NEW.unit_id,
      'unitVersion',NEW.unit_version
    )
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_client_question_notification
  AFTER INSERT ON client_questions
  FOR EACH ROW EXECUTE FUNCTION notify_client_question();

CREATE FUNCTION notify_client_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  exact_version integer;
BEGIN
  SELECT current_version INTO exact_version
  FROM units
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND id = NEW.origin_unit_id;
  IF exact_version IS NULL THEN
    RAISE EXCEPTION 'notification correction basis is unavailable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM enqueue_notification_intent(
    NEW.workspace_id,NEW.project_id,'client-correction-submitted','provider',
    NEW.actor_id,'client-correction',NEW.id,
    'client-correction:' || NEW.id,
    jsonb_build_object(
      'concernId',NEW.id,
      'requestId',NEW.packet_id,
      'unitId',NEW.origin_unit_id,
      'unitVersion',exact_version
    )
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_client_correction_notification
  AFTER INSERT ON corrections
  FOR EACH ROW EXECUTE FUNCTION notify_client_correction();

CREATE FUNCTION notify_provider_question_response() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  question client_questions%ROWTYPE;
BEGIN
  SELECT * INTO question
  FROM client_questions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND question_id = NEW.question_id;
  IF question.question_id IS NULL THEN
    RAISE EXCEPTION 'notification question response basis is unavailable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM enqueue_notification_intent(
    NEW.workspace_id,NEW.project_id,'provider-question-responded',
    'client-approver',NEW.responded_by,'provider-question-response',
    NEW.question_id::text || ':' || NEW.revision::text,
    'provider-question-response:' || NEW.question_id::text || ':' ||
      NEW.revision::text,
    jsonb_build_object(
      'questionId',NEW.question_id::text,
      'unitId',question.unit_id,
      'unitVersion',question.unit_version,
      'responseRevision',NEW.revision,
      'status',NEW.status
    )
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_provider_question_response_notification
  AFTER INSERT ON provider_question_responses
  FOR EACH ROW EXECUTE FUNCTION notify_provider_question_response();

CREATE FUNCTION notify_provider_correction_assessment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_notification_intent(
    NEW.workspace_id,NEW.project_id,'provider-correction-assessed',
    'client-approver',NEW.assessed_by,'provider-correction-assessment',
    NEW.concern_id || ':' || NEW.assessment_revision::text,
    'provider-correction-assessment:' || NEW.concern_id || ':' ||
      NEW.assessment_revision::text,
    jsonb_build_object(
      'concernId',NEW.concern_id,
      'unitId',NEW.unit_id,
      'unitVersion',NEW.unit_version,
      'assessmentRevision',NEW.assessment_revision,
      'applicability',NEW.applicability,
      'reissueDraftRevision',NEW.draft_revision
    )
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_provider_correction_assessment_notification
  AFTER INSERT ON provider_reconciliation_assessments
  FOR EACH ROW EXECUTE FUNCTION notify_provider_correction_assessment();

CREATE FUNCTION notify_provider_reissue_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  publication unit_versions%ROWTYPE;
BEGIN
  IF NEW.version <= 1 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO publication
  FROM unit_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND unit_id = NEW.unit_id
    AND version = NEW.version;
  IF publication.unit_id IS NULL
    OR jsonb_array_length(publication.snapshot->'reconciliation') = 0 THEN
    RETURN NEW;
  END IF;
  PERFORM enqueue_notification_intent(
    NEW.workspace_id,NEW.project_id,'provider-reissue-published',
    'client-approver',NEW.published_by,'provider-publication',
    NEW.unit_id || ':' || NEW.version::text,
    'provider-reissue:' || NEW.unit_id || ':' || NEW.version::text,
    jsonb_build_object(
      'unitId',NEW.unit_id,
      'version',NEW.version,
      'previousVersion',NEW.version - 1
    )
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_provider_reissue_notification
  AFTER INSERT ON provider_publication_provenance
  FOR EACH ROW EXECUTE FUNCTION notify_provider_reissue_publication();

CREATE FUNCTION notify_participant_or_payment_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  notice_role text;
  notice_change text;
  notice_purpose text;
  authority_epoch integer;
  notice_unit_id text;
  notice_version integer;
BEGIN
  IF NEW.event IN (
    'local-client-approver-activated',
    'approver-authority-revoked',
    'approver-authority-restored',
    'local-payer-authority-activated',
    'payer-authority-revoked',
    'payer-authority-restored'
  ) THEN
    notice_role := CASE
      WHEN NEW.event LIKE '%payer%' THEN 'payer'
      ELSE 'client-approver'
    END;
    notice_change := CASE
      WHEN NEW.event LIKE '%revoked' THEN 'revoked'
      WHEN NEW.event LIKE '%restored' THEN 'restored'
      ELSE 'activated'
    END;
    notice_purpose := 'participant-authority-' || notice_change;
    authority_epoch := CASE
      WHEN notice_role = 'payer'
        THEN (NEW.detail->>'grantEpoch')::integer
      ELSE (NEW.detail#>>'{grantEpochs,inspect}')::integer
    END;
    IF notice_role = 'payer' THEN
      SELECT unit_id,version INTO notice_unit_id,notice_version
      FROM obligations
      WHERE workspace_id = NEW.workspace_id
        AND project_id = NEW.project_id
        AND id = NEW.resource_id;
      IF notice_unit_id IS NULL OR notice_version IS NULL THEN
        RAISE EXCEPTION 'notification payer authority basis is unavailable'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      notice_unit_id := NULL;
      notice_version := NULL;
    END IF;
    PERFORM enqueue_notification_intent(
      NEW.workspace_id,NEW.project_id,notice_purpose,notice_role,
      NEW.actor_id,'participant-history',NEW.sequence::text,
      'participant:' || NEW.event || ':' || NEW.sequence::text,
      jsonb_build_object(
        'role',notice_role,
        'change',notice_change,
        'resourceId',NEW.resource_id,
        'authorityEpoch',authority_epoch,
        'unitId',notice_unit_id,
        'version',notice_version
      )
    );
  ELSIF NEW.event = 'payment-exception-observed' THEN
    SELECT obligation.unit_id,obligation.version
      INTO notice_unit_id,notice_version
    FROM operations operation
    JOIN attempts attempt
      ON attempt.workspace_id = operation.workspace_id
      AND attempt.project_id = operation.project_id
      AND attempt.id = operation.attempt_id
    JOIN obligations obligation
      ON obligation.workspace_id = attempt.workspace_id
      AND obligation.project_id = attempt.project_id
      AND obligation.id = attempt.obligation_id
    WHERE operation.workspace_id = NEW.workspace_id
      AND operation.project_id = NEW.project_id
      AND operation.id::text = NEW.detail->>'operationId';
    IF notice_unit_id IS NULL OR notice_version IS NULL THEN
      RAISE EXCEPTION 'notification payment exception basis is unavailable'
        USING ERRCODE = '23514';
    END IF;
    PERFORM enqueue_notification_intent(
      NEW.workspace_id,NEW.project_id,'payment-exception-observed','provider',
      NEW.actor_id,'payment-exception-history',NEW.sequence::text,
      'payment-exception:' || NEW.sequence::text,
      jsonb_build_object(
        'observationSequence',NEW.sequence,
        'unitId',notice_unit_id,
        'version',notice_version,
        'kind',NEW.detail->>'kind',
        'state',NEW.detail->>'state'
      )
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_participant_and_payment_notifications
  AFTER INSERT ON protocol_history
  FOR EACH ROW EXECUTE FUNCTION notify_participant_or_payment_history();

INSERT INTO schema_migrations(version) VALUES (9);
`;
