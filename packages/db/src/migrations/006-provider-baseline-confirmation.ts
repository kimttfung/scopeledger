/** Reviewed PostgreSQL SQL. Adds explicit immutable source-backed baseline confirmation. */
export const migration006 = `
CREATE TABLE provider_baseline_confirmations (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  baseline_id text NOT NULL CHECK (
    baseline_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  baseline_version integer NOT NULL CHECK (baseline_version > 0),
  request_id text NOT NULL,
  source_id text NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_record_digest text NOT NULL CHECK (
    source_record_digest ~ '^[a-f0-9]{64}$'
  ),
  acceptance_kind text NOT NULL CHECK (
    acceptance_kind = 'provider-attested-import'
  ),
  acceptance_basis text NOT NULL CHECK (
    authoring_text_is_valid(acceptance_basis,2000,false,true)
    AND acceptance_basis ~ '[^[:space:]]'
  ),
  studio_sharing text NOT NULL CHECK (studio_sharing = 'permitted'),
  confirmed_by text NOT NULL CHECK (
    confirmed_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmation_digest text NOT NULL CHECK (
    confirmation_digest ~ '^[a-f0-9]{64}$'
  ),
  PRIMARY KEY (
    workspace_id,project_id,baseline_id,baseline_version
  ),
  UNIQUE (
    workspace_id,project_id,source_id,source_version
  ),
  FOREIGN KEY (workspace_id,project_id,request_id)
    REFERENCES packets(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version)
    REFERENCES source_intake_records(
      workspace_id,project_id,source_id,source_version
    ),
  FOREIGN KEY (
    workspace_id,project_id,baseline_id,baseline_version
  ) REFERENCES baseline_versions(workspace_id,project_id,id,version)
);

CREATE FUNCTION validate_provider_baseline_confirmation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  project_is_provider_created boolean;
  actual_latest_version integer;
  actual_availability text;
  actual_record_digest text;
  actual_acceptance_kind text;
  actual_acceptance_basis text;
  actual_studio_sharing text;
  actual_confirmed_by text;
BEGIN
  SELECT provider_creation_digest IS NOT NULL
    INTO project_is_provider_created
  FROM projects
  WHERE workspace_id = NEW.workspace_id
    AND id = NEW.project_id
  FOR SHARE;
  IF NOT FOUND OR NOT project_is_provider_created THEN
    RAISE EXCEPTION 'provider baseline confirmation requires a provider-created project'
      USING ERRCODE = '23514';
  END IF;

  SELECT sv.availability,sir.record_digest,sir.acceptance_kind,
      sir.acceptance_basis,sir.studio_sharing,
      (
        SELECT max(newer.version)::integer
        FROM source_versions newer
        WHERE newer.workspace_id = sv.workspace_id
          AND newer.project_id = sv.project_id
          AND newer.id = sv.id
      )
    INTO actual_availability,actual_record_digest,actual_acceptance_kind,
      actual_acceptance_basis,actual_studio_sharing,actual_latest_version
  FROM source_versions sv
  JOIN source_intake_records sir
    ON sir.workspace_id = sv.workspace_id
    AND sir.project_id = sv.project_id
    AND sir.source_id = sv.id
    AND sir.source_version = sv.version
  WHERE sv.workspace_id = NEW.workspace_id
    AND sv.project_id = NEW.project_id
    AND sv.id = NEW.source_id
    AND sv.version = NEW.source_version
  FOR KEY SHARE OF sv,sir;
  IF NOT FOUND
    OR actual_latest_version IS DISTINCT FROM NEW.source_version
    OR actual_availability <> 'available'
    OR actual_record_digest IS DISTINCT FROM NEW.source_record_digest
    OR actual_acceptance_kind <> 'provider-attested-import'
    OR actual_acceptance_kind IS DISTINCT FROM NEW.acceptance_kind
    OR actual_acceptance_basis IS DISTINCT FROM NEW.acceptance_basis
    OR actual_studio_sharing <> 'permitted'
    OR actual_studio_sharing IS DISTINCT FROM NEW.studio_sharing THEN
    RAISE EXCEPTION 'provider baseline source basis is stale or not confirmable'
      USING ERRCODE = '23514';
  END IF;

  SELECT confirmed_by INTO actual_confirmed_by
  FROM baseline_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND id = NEW.baseline_id
    AND version = NEW.baseline_version
  FOR KEY SHARE;
  IF NOT FOUND OR actual_confirmed_by IS DISTINCT FROM NEW.confirmed_by THEN
    RAISE EXCEPTION 'provider baseline authority does not match'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_provider_baseline_confirmation
  BEFORE INSERT ON provider_baseline_confirmations
  FOR EACH ROW EXECUTE FUNCTION validate_provider_baseline_confirmation();

CREATE TRIGGER immutable_provider_baseline_confirmation
  BEFORE UPDATE OR DELETE ON provider_baseline_confirmations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

INSERT INTO schema_migrations(version) VALUES (6);
`;
