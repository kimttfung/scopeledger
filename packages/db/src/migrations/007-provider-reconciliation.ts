/** Reviewed PostgreSQL SQL. Adds immutable provider inbox responses and correction assessments. */
export const migration007 = `
CREATE TABLE provider_question_responses (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  question_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  command_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (
    status IN ('answered','needs-client-information','closed')
  ),
  response_text text NOT NULL CHECK (
    authoring_text_is_valid(response_text,5000,false,true)
    AND response_text ~ '[^[:space:]]'
  ),
  responded_by text NOT NULL CHECK (
    responded_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  responded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (workspace_id,project_id,question_id,revision),
  UNIQUE (workspace_id,project_id,responded_by,command_id),
  FOREIGN KEY (workspace_id,project_id,question_id)
    REFERENCES client_questions(workspace_id,project_id,question_id)
);

CREATE FUNCTION require_next_provider_question_response() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_revision integer;
BEGIN
  SELECT max(revision)::integer INTO latest_revision
  FROM provider_question_responses
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND question_id = NEW.question_id;
  IF NEW.revision <> coalesce(latest_revision,0) + 1 THEN
    RAISE EXCEPTION 'question response revisions must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sequential_provider_question_response
  BEFORE INSERT ON provider_question_responses
  FOR EACH ROW EXECUTE FUNCTION require_next_provider_question_response();
CREATE TRIGGER immutable_provider_question_response
  BEFORE UPDATE OR DELETE ON provider_question_responses
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE provider_reconciliation_assessments (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  concern_id text NOT NULL,
  assessment_revision integer NOT NULL CHECK (assessment_revision > 0),
  command_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  applicability text NOT NULL CHECK (
    applicability IN (
      'no-material-change','material-change','needs-information'
    )
  ),
  request_id text NOT NULL,
  unit_id text NOT NULL,
  unit_version integer NOT NULL CHECK (unit_version > 0),
  unit_digest text NOT NULL CHECK (unit_digest ~ '^[a-f0-9]{64}$'),
  response_revision integer NOT NULL CHECK (response_revision > 0),
  provider_response text NOT NULL CHECK (
    authoring_text_is_valid(provider_response,5000,false,true)
    AND provider_response ~ '[^[:space:]]'
  ),
  source_review text NOT NULL CHECK (
    authoring_text_is_valid(source_review,5000,false,true)
    AND source_review ~ '[^[:space:]]'
  ),
  assessed_by text NOT NULL CHECK (
    assessed_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  draft_revision integer CHECK (draft_revision > 0),
  draft_digest text CHECK (
    draft_digest IS NULL OR draft_digest ~ '^[a-f0-9]{64}$'
  ),
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (
    workspace_id,project_id,concern_id,assessment_revision
  ),
  UNIQUE (workspace_id,project_id,assessed_by,command_id),
  FOREIGN KEY (workspace_id,project_id,concern_id)
    REFERENCES corrections(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,unit_id,request_id)
    REFERENCES units(workspace_id,project_id,id,packet_id),
  FOREIGN KEY (workspace_id,project_id,unit_id,unit_version)
    REFERENCES unit_versions(workspace_id,project_id,unit_id,version),
  FOREIGN KEY (
    workspace_id,project_id,concern_id,response_revision
  ) REFERENCES correction_responses(
    workspace_id,project_id,concern_id,revision
  ),
  FOREIGN KEY (
    workspace_id,project_id,unit_id,draft_revision,draft_digest
  ) REFERENCES provider_authoring_draft_versions(
    workspace_id,project_id,unit_id,revision,draft_digest
  ),
  CHECK (
    (
      applicability = 'material-change'
      AND draft_revision IS NOT NULL
      AND draft_digest IS NOT NULL
    )
    OR (
      applicability <> 'material-change'
      AND draft_revision IS NULL
      AND draft_digest IS NULL
    )
  )
);

CREATE FUNCTION validate_provider_reconciliation_assessment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_request_id text;
  actual_current_version integer;
  actual_digest text;
  actual_response_disposition text;
  actual_response_actor text;
  actual_response_source_review text;
  actual_response_explanation text;
  latest_response_revision integer;
  latest_assessment_revision integer;
  actual_draft_request text;
  actual_draft_state text;
  actual_draft_actor text;
BEGIN
  SELECT u.packet_id,u.current_version,v.digest
    INTO actual_request_id,actual_current_version,actual_digest
  FROM units u
  JOIN unit_versions v
    ON v.workspace_id = u.workspace_id
    AND v.project_id = u.project_id
    AND v.unit_id = u.id
    AND v.version = u.current_version
  WHERE u.workspace_id = NEW.workspace_id
    AND u.project_id = NEW.project_id
    AND u.id = NEW.unit_id
  FOR KEY SHARE OF u,v;
  IF NOT FOUND
    OR actual_request_id IS DISTINCT FROM NEW.request_id
    OR actual_current_version IS DISTINCT FROM NEW.unit_version
    OR actual_digest IS DISTINCT FROM NEW.unit_digest THEN
    RAISE EXCEPTION 'reconciliation assessment requires the exact current unit'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corrections c
    JOIN holds h
      ON h.workspace_id = c.workspace_id
      AND h.project_id = c.project_id
      AND h.unit_id = c.origin_unit_id
      AND h.concern_id = c.id
      AND h.reason = 'correction'
      AND h.resolved_at IS NULL
    WHERE c.workspace_id = NEW.workspace_id
      AND c.project_id = NEW.project_id
      AND c.id = NEW.concern_id
      AND c.packet_id = NEW.request_id
      AND c.origin_unit_id = NEW.unit_id
  ) THEN
    RAISE EXCEPTION 'reconciliation assessment requires an active exact concern'
      USING ERRCODE = '23514';
  END IF;

  SELECT r.disposition,r.actor_id,r.source_review,r.explanation,
      (
        SELECT max(newer.revision)::integer
        FROM correction_responses newer
        WHERE newer.workspace_id = r.workspace_id
          AND newer.project_id = r.project_id
          AND newer.concern_id = r.concern_id
      )
    INTO actual_response_disposition,actual_response_actor,
      actual_response_source_review,actual_response_explanation,
      latest_response_revision
  FROM correction_responses r
  WHERE r.workspace_id = NEW.workspace_id
    AND r.project_id = NEW.project_id
    AND r.concern_id = NEW.concern_id
    AND r.revision = NEW.response_revision
  FOR KEY SHARE;
  IF NOT FOUND
    OR actual_response_actor IS DISTINCT FROM NEW.assessed_by
    OR actual_response_source_review IS DISTINCT FROM NEW.source_review
    OR actual_response_explanation IS DISTINCT FROM NEW.provider_response
    OR latest_response_revision IS DISTINCT FROM NEW.response_revision
    OR (
      NEW.applicability = 'no-material-change'
      AND actual_response_disposition <> 'maintain'
    )
    OR (
      NEW.applicability = 'material-change'
      AND actual_response_disposition <> 'accept'
    )
    OR (
      NEW.applicability = 'needs-information'
      AND actual_response_disposition <> 'request-information'
    ) THEN
    RAISE EXCEPTION 'assessment does not match the current attributed response'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(assessment_revision)::integer INTO latest_assessment_revision
  FROM provider_reconciliation_assessments
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND concern_id = NEW.concern_id;
  IF NEW.assessment_revision <> coalesce(latest_assessment_revision,0) + 1 THEN
    RAISE EXCEPTION 'assessment revisions must be sequential'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.applicability = 'material-change' THEN
    SELECT request_id,state,authored_by
      INTO actual_draft_request,actual_draft_state,actual_draft_actor
    FROM provider_authoring_draft_versions
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND unit_id = NEW.unit_id
      AND revision = NEW.draft_revision
      AND draft_digest = NEW.draft_digest
    FOR KEY SHARE;
    IF NOT FOUND
      OR actual_draft_request IS DISTINCT FROM NEW.request_id
      OR actual_draft_state <> 'in-progress'
      OR actual_draft_actor IS DISTINCT FROM NEW.assessed_by THEN
      RAISE EXCEPTION 'material assessment requires its exact attributed draft'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_provider_reconciliation_assessment
  BEFORE INSERT ON provider_reconciliation_assessments
  FOR EACH ROW EXECUTE FUNCTION validate_provider_reconciliation_assessment();
CREATE TRIGGER immutable_provider_reconciliation_assessment
  BEFORE UPDATE OR DELETE ON provider_reconciliation_assessments
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE INDEX provider_reconciliation_assessments_by_unit
  ON provider_reconciliation_assessments(
    workspace_id,project_id,unit_id,unit_version,assessed_at,concern_id
  );

INSERT INTO schema_migrations(version) VALUES (7);
`;
