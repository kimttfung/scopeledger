/** Reviewed PostgreSQL SQL. Stores normalized runtime records only, never raw provider payloads or access codes. */
export const migration002 = `
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_paypal_scope UNIQUE (id,merchant_id,environment);

CREATE TABLE access_challenges (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id uuid NOT NULL,
  recipient_reference text NOT NULL
    CHECK (char_length(recipient_reference) BETWEEN 1 AND 320
      AND recipient_reference = btrim(recipient_reference)
      AND recipient_reference !~ '[[:cntrl:]]'),
  role text NOT NULL CHECK (role IN ('client-approver','payer')),
  code_digest text NOT NULL CHECK (code_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','verified','superseded')),
  verified_at timestamptz,
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id),
  CHECK (expires_at > issued_at),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK (verified_at IS NULL OR (verified_at >= issued_at AND verified_at < expires_at))
);
CREATE UNIQUE INDEX one_active_access_challenge
  ON access_challenges(workspace_id,project_id,recipient_reference,role)
  WHERE status = 'active';

CREATE FUNCTION protect_access_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'active'
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.recipient_reference IS DISTINCT FROM OLD.recipient_reference
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.code_digest IS DISTINCT FROM OLD.code_digest
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.attempts < OLD.attempts
    OR NEW.attempts > OLD.attempts + 1
    OR (NEW.status <> 'active' AND NEW.attempts <> OLD.attempts) THEN
    RAISE EXCEPTION 'access challenge identity/history cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_access_challenge BEFORE UPDATE ON access_challenges
  FOR EACH ROW EXECUTE FUNCTION protect_access_challenge();
CREATE TRIGGER durable_access_challenge BEFORE DELETE ON access_challenges
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE paypal_webhook_receipts (
  workspace_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  merchant_id text NOT NULL
    CHECK (char_length(merchant_id) BETWEEN 1 AND 96 AND merchant_id !~ '[[:cntrl:]]'),
  event_id text NOT NULL
    CHECK (char_length(event_id) BETWEEN 1 AND 96 AND event_id !~ '[[:cntrl:]]'),
  event_type text NOT NULL CHECK (event_type IN (
    'CHECKOUT.ORDER.APPROVED',
    'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.REFUNDED',
    'PAYMENT.CAPTURE.REVERSED',
    'PAYMENT.REFUND.PENDING',
    'PAYMENT.REFUND.COMPLETED',
    'PAYMENT.REFUND.FAILED'
  )),
  resource_type text NOT NULL
    CHECK (char_length(resource_type) BETWEEN 1 AND 128 AND resource_type !~ '[[:cntrl:]]'),
  resource_id text CHECK (
    resource_id IS NULL OR (char_length(resource_id) BETWEEN 1 AND 256 AND resource_id !~ '[[:cntrl:]]')
  ),
  resource_status text CHECK (
    resource_status IS NULL OR (char_length(resource_status) BETWEEN 1 AND 128 AND resource_status !~ '[[:cntrl:]]')
  ),
  provider_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  verification_reference text NOT NULL
    CHECK (char_length(verification_reference) BETWEEN 1 AND 256
      AND verification_reference !~ '[[:cntrl:]]'),
  PRIMARY KEY (environment,merchant_id,event_id),
  FOREIGN KEY (workspace_id,merchant_id,environment)
    REFERENCES workspaces(id,merchant_id,environment)
);
CREATE TRIGGER immutable_paypal_webhook_receipt
  BEFORE UPDATE OR DELETE ON paypal_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE paypal_approval_links (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  operation_id uuid NOT NULL,
  order_id text NOT NULL
    CHECK (char_length(order_id) BETWEEN 1 AND 96 AND order_id !~ '[[:cntrl:]]'),
  approval_url text NOT NULL CHECK (
    char_length(approval_url) BETWEEN 1 AND 2048
    AND approval_url ~ '^https://www[.](sandbox[.])?paypal[.]com(/|$)'
  ),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,operation_id),
  UNIQUE (workspace_id,project_id,order_id),
  FOREIGN KEY (workspace_id,project_id,operation_id)
    REFERENCES operations(workspace_id,project_id,id)
);
CREATE FUNCTION protect_paypal_approval_link_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation_kind text;
  recorded_order_id text;
  workspace_environment text;
BEGIN
  SELECT o.kind,a.order_id,w.environment
    INTO operation_kind,recorded_order_id,workspace_environment
  FROM operations o
  JOIN attempts a
    ON a.workspace_id = o.workspace_id
    AND a.project_id = o.project_id
    AND a.id = o.attempt_id
  JOIN workspaces w ON w.id = o.workspace_id
  WHERE o.workspace_id = NEW.workspace_id
    AND o.project_id = NEW.project_id
    AND o.id = NEW.operation_id;
  IF operation_kind IS NULL
    OR operation_kind <> 'create'
    OR recorded_order_id IS DISTINCT FROM NEW.order_id
    OR (workspace_environment = 'sandbox'
      AND NEW.approval_url !~ '^https://www[.]sandbox[.]paypal[.]com(/|$)')
    OR (workspace_environment = 'live'
      AND NEW.approval_url !~ '^https://www[.]paypal[.]com(/|$)') THEN
    RAISE EXCEPTION 'approval link requires the matching create operation basis'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_paypal_approval_link_basis
  BEFORE INSERT ON paypal_approval_links
  FOR EACH ROW EXECUTE FUNCTION protect_paypal_approval_link_basis();
CREATE TRIGGER immutable_paypal_approval_link
  BEFORE UPDATE OR DELETE ON paypal_approval_links
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

INSERT INTO schema_migrations(version) VALUES (2);
`;
