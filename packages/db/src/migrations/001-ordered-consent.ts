/** Reviewed PostgreSQL SQL. No extension, public-schema mutation or provider call is required. */
export const migration001 = `
CREATE TABLE schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE workspaces (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','live'))
);
CREATE TABLE projects (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  client_id text NOT NULL,
  approver_id text NOT NULL,
  nomination_epoch integer NOT NULL DEFAULT 1 CHECK (nomination_epoch > 0),
  context_revision integer NOT NULL DEFAULT 1 CHECK (context_revision > 0),
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE grants (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('publish','decide','correct','nominate','review','pay','inspect')),
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id,project_id,actor_id,action),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE packets (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE units (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  packet_id text NOT NULL,
  current_version integer,
  accepted_version integer,
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,packet_id) REFERENCES packets(workspace_id,project_id,id)
);
CREATE TABLE source_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  availability text NOT NULL CHECK (availability IN ('available','unavailable')),
  reviewed_by text NOT NULL,
  PRIMARY KEY (workspace_id,project_id,id,version),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE baseline_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  confirmed_by text NOT NULL,
  PRIMARY KEY (workspace_id,project_id,id,version),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE unit_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  unit_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  canonical_bytes bytea NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,unit_id) REFERENCES units(workspace_id,project_id,id),
  CHECK (encode(sha256(canonical_bytes),'hex') = digest),
  CHECK (convert_from(canonical_bytes,'UTF8')::jsonb = snapshot),
  CHECK (jsonb_typeof(snapshot) = 'object' AND snapshot ?& ARRAY[
    'schemaVersion','serializationVersion','workspaceId','projectId','unitId','version','treatment']),
  CHECK (snapshot->>'schemaVersion' = 'scopeledger.published-unit.v1'),
  CHECK (snapshot->>'serializationVersion' = 'scopeledger.canonical-json.v1'),
  CHECK (snapshot->>'workspaceId' = workspace_id AND snapshot->>'projectId' = project_id
    AND snapshot->>'unitId' = unit_id AND (snapshot->>'version')::integer = version),
  CHECK (snapshot->>'treatment' IN ('payable','additional-waived'))
);
ALTER TABLE units ADD FOREIGN KEY (workspace_id,project_id,id,current_version)
  REFERENCES unit_versions(workspace_id,project_id,unit_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE units ADD FOREIGN KEY (workspace_id,project_id,id,accepted_version)
  REFERENCES unit_versions(workspace_id,project_id,unit_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE version_sources (
  workspace_id text NOT NULL, project_id text NOT NULL, unit_id text NOT NULL, version integer NOT NULL,
  source_id text NOT NULL, source_version integer NOT NULL,
  PRIMARY KEY (workspace_id,project_id,unit_id,version,source_id,source_version),
  FOREIGN KEY (workspace_id,project_id,unit_id,version) REFERENCES unit_versions(workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version) REFERENCES source_versions(workspace_id,project_id,id,version)
);
CREATE TABLE version_baselines (
  workspace_id text NOT NULL, project_id text NOT NULL, unit_id text NOT NULL, version integer NOT NULL,
  baseline_id text NOT NULL, baseline_version integer NOT NULL,
  PRIMARY KEY (workspace_id,project_id,unit_id,version,baseline_id,baseline_version),
  FOREIGN KEY (workspace_id,project_id,unit_id,version) REFERENCES unit_versions(workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,baseline_id,baseline_version) REFERENCES baseline_versions(workspace_id,project_id,id,version)
);
CREATE TABLE decisions (
  workspace_id text NOT NULL, project_id text NOT NULL, unit_id text NOT NULL, version integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','decline')),
  actor_id text NOT NULL, nomination_epoch integer NOT NULL,
  digest text NOT NULL, attestation jsonb NOT NULL, resolution jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,unit_id,version) REFERENCES unit_versions(workspace_id,project_id,unit_id,version)
);
CREATE TABLE corrections (
  workspace_id text NOT NULL, project_id text NOT NULL, id text NOT NULL,
  packet_id text NOT NULL, origin_unit_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('known','unknown')),
  impact_revision integer NOT NULL,
  claim jsonb NOT NULL, actor_id text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,packet_id) REFERENCES packets(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,origin_unit_id) REFERENCES units(workspace_id,project_id,id)
);
CREATE TABLE correction_responses (
  workspace_id text NOT NULL, project_id text NOT NULL, concern_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  disposition text NOT NULL CHECK (disposition IN ('accept','partial','maintain','request-information')),
  source_review text NOT NULL, explanation text NOT NULL, actor_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,concern_id,revision),
  FOREIGN KEY (workspace_id,project_id,concern_id) REFERENCES corrections(workspace_id,project_id,id)
);
CREATE TABLE holds (
  workspace_id text NOT NULL, project_id text NOT NULL, unit_id text NOT NULL,
  id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('correction','impact','source','stop','financial','restore')),
  concern_id text, basis text NOT NULL, actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz, resolved_by text, resolution_basis jsonb,
  PRIMARY KEY (workspace_id,project_id,unit_id,id),
  FOREIGN KEY (workspace_id,project_id,unit_id) REFERENCES units(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,concern_id) REFERENCES corrections(workspace_id,project_id,id),
  CHECK ((resolved_at IS NULL AND resolved_by IS NULL AND resolution_basis IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_basis IS NOT NULL)),
  CHECK (reason NOT IN ('correction','impact') OR concern_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_concern_hold
  ON holds(workspace_id,project_id,unit_id,concern_id,reason)
  WHERE resolved_at IS NULL AND concern_id IS NOT NULL;
CREATE TABLE impact_reviews (
  workspace_id text NOT NULL, project_id text NOT NULL, concern_id text NOT NULL, unit_id text NOT NULL,
  impact_revision integer NOT NULL, disposition text NOT NULL CHECK (disposition IN ('independent','affected')),
  explanation text NOT NULL, actor_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,concern_id,unit_id),
  FOREIGN KEY (workspace_id,project_id,concern_id) REFERENCES corrections(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,unit_id) REFERENCES units(workspace_id,project_id,id)
);
CREATE TABLE collection_families (
  workspace_id text NOT NULL, project_id text NOT NULL, id text NOT NULL,
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,id) REFERENCES units(workspace_id,project_id,id)
);
CREATE TABLE obligations (
  workspace_id text NOT NULL, project_id text NOT NULL, id text NOT NULL,
  unit_id text NOT NULL, version integer NOT NULL, family_id text NOT NULL,
  merchant_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  currency text NOT NULL CHECK (currency = 'USD'),
  gross text NOT NULL CHECK (gross ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' AND gross::numeric > 0 AND gross::numeric <= 9999999999.99),
  collectible boolean NOT NULL DEFAULT true,
  replaces_id text,
  PRIMARY KEY (workspace_id,project_id,id),
  UNIQUE (workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,unit_id,version) REFERENCES decisions(workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,family_id) REFERENCES collection_families(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,replaces_id) REFERENCES obligations(workspace_id,project_id,id)
);
CREATE UNIQUE INDEX one_collectible_family ON obligations(workspace_id,project_id,family_id) WHERE collectible;
CREATE TABLE payer_nominations (
  workspace_id text NOT NULL, project_id text NOT NULL, obligation_id text NOT NULL,
  actor_id text NOT NULL, epoch integer NOT NULL CHECK (epoch > 0),
  continuity_epoch integer NOT NULL CHECK (continuity_epoch > 0), active boolean NOT NULL,
  nominated_by text NOT NULL, basis text NOT NULL,
  PRIMARY KEY (workspace_id,project_id,obligation_id),
  FOREIGN KEY (workspace_id,project_id,obligation_id) REFERENCES obligations(workspace_id,project_id,id)
);
CREATE TABLE attempts (
  workspace_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL,
  obligation_id text NOT NULL, initiated_by text NOT NULL, payer_epoch integer NOT NULL,
  nomination_epoch integer NOT NULL, state text NOT NULL CHECK (state IN
    ('intent','create-admitted','order-available','capture-intent','capture-admitted','pending','unknown','completed')),
  order_id text, resolved_at timestamptz,
  capture_forbidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,obligation_id) REFERENCES obligations(workspace_id,project_id,id),
  CHECK ((state = 'completed') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_unresolved_attempt ON attempts(workspace_id,project_id,obligation_id) WHERE resolved_at IS NULL;
CREATE TABLE operations (
  workspace_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL,
  attempt_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('create','capture')),
  request jsonb NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  provider_key uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('intent','admitted','pending','unknown','result')),
  lease_token uuid, lease_generation integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
  admitted_at timestamptz, admission jsonb, result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,id),
  UNIQUE (workspace_id,project_id,attempt_id,kind),
  UNIQUE (provider_key),
  FOREIGN KEY (workspace_id,project_id,attempt_id) REFERENCES attempts(workspace_id,project_id,id),
  CHECK ((admitted_at IS NULL) = (admission IS NULL)),
  CHECK ((state = 'intent') = (admitted_at IS NULL))
);
CREATE TABLE observations (
  workspace_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL,
  operation_id uuid NOT NULL, payload jsonb NOT NULL,
  matches_basis boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,operation_id) REFERENCES operations(workspace_id,project_id,id)
);
CREATE TABLE payment_facts (
  workspace_id text NOT NULL, project_id text NOT NULL, operation_id uuid NOT NULL,
  capture_id text NOT NULL, order_id text NOT NULL, merchant_id text NOT NULL, environment text NOT NULL,
  currency text NOT NULL CHECK (currency = 'USD'),
  gross text NOT NULL CHECK (gross ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' AND gross::numeric > 0 AND gross::numeric <= 9999999999.99),
  evidence jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,operation_id),
  UNIQUE (merchant_id,environment,capture_id),
  FOREIGN KEY (workspace_id,project_id,operation_id) REFERENCES operations(workspace_id,project_id,id)
);
CREATE TABLE prerequisite_observations (
  workspace_id text NOT NULL, project_id text NOT NULL, unit_id text NOT NULL, version integer NOT NULL,
  prerequisite_id text NOT NULL, prerequisite_version integer NOT NULL,
  actor_id text NOT NULL, satisfied boolean NOT NULL, basis text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,unit_id,version,prerequisite_id),
  FOREIGN KEY (workspace_id,project_id,unit_id,version) REFERENCES unit_versions(workspace_id,project_id,unit_id,version)
);
CREATE TABLE command_receipts (
  workspace_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, command_id uuid NOT NULL,
  action text NOT NULL, payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,actor_id,command_id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE protocol_history (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  event text NOT NULL, resource_id text NOT NULL, detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE FUNCTION prevent_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable protocol record' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_published BEFORE UPDATE OR DELETE ON unit_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_decision BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_response BEFORE UPDATE OR DELETE ON correction_responses
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_correction BEFORE UPDATE OR DELETE ON corrections
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON command_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON protocol_history
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_observation BEFORE UPDATE OR DELETE ON observations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_fact BEFORE UPDATE OR DELETE ON payment_facts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_source_version BEFORE UPDATE OR DELETE ON source_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_baseline_version BEFORE UPDATE OR DELETE ON baseline_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_version_source BEFORE UPDATE OR DELETE ON version_sources
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_version_baseline BEFORE UPDATE OR DELETE ON version_baselines
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER durable_operation BEFORE DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER durable_attempt BEFORE DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER durable_obligation BEFORE DELETE ON obligations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE FUNCTION protect_obligation_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'collectible') IS DISTINCT FROM (to_jsonb(OLD) - 'collectible') THEN
      RAISE EXCEPTION 'immutable financial basis' USING ERRCODE = '23514';
    END IF;
    IF OLD.collectible AND NOT NEW.collectible AND EXISTS (
      SELECT 1 FROM attempts WHERE workspace_id = OLD.workspace_id AND project_id = OLD.project_id AND obligation_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'attempt closure evidence required before disabling collection' USING ERRCODE = '23514';
    END IF;
    IF NOT OLD.collectible AND NEW.collectible THEN
      RAISE EXCEPTION 'old collection cannot be reactivated' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT v.snapshot INTO basis FROM decisions d JOIN unit_versions v
      ON v.workspace_id = d.workspace_id AND v.project_id = d.project_id AND v.unit_id = d.unit_id AND v.version = d.version
      WHERE d.workspace_id = NEW.workspace_id AND d.project_id = NEW.project_id AND d.unit_id = NEW.unit_id
        AND d.version = NEW.version AND d.decision = 'approve';
    IF basis IS NULL OR basis->>'treatment' <> 'payable'
      OR basis#>>'{payment,financial,merchantId}' IS DISTINCT FROM NEW.merchant_id
      OR basis#>>'{payment,financial,environment}' IS DISTINCT FROM NEW.environment
      OR basis#>>'{payment,financial,currency}' IS DISTINCT FROM NEW.currency
      OR basis#>>'{payment,financial,gross}' IS DISTINCT FROM NEW.gross THEN
      RAISE EXCEPTION 'obligation requires the exact approved payable basis' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_obligation_basis BEFORE INSERT OR UPDATE ON obligations
  FOR EACH ROW EXECUTE FUNCTION protect_obligation_basis();
CREATE FUNCTION protect_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by OR NEW.payer_epoch IS DISTINCT FROM OLD.payer_epoch
    OR NEW.nomination_epoch IS DISTINCT FROM OLD.nomination_epoch OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id)
    OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.state <> OLD.state))
    OR (OLD.capture_forbidden AND NOT NEW.capture_forbidden) THEN
    RAISE EXCEPTION 'attempt identity/history cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_attempt BEFORE UPDATE ON attempts
  FOR EACH ROW EXECUTE FUNCTION protect_attempt_identity();
CREATE FUNCTION protect_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request IS DISTINCT FROM OLD.request
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.lease_generation < OLD.lease_generation
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.admitted_at IS NOT NULL AND (NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
      OR NEW.admission IS DISTINCT FROM OLD.admission OR NEW.state = 'intent')) THEN
    RAISE EXCEPTION 'operation identity/admission is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_operation BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION protect_operation_identity();
INSERT INTO schema_migrations(version) VALUES (1);
`;
