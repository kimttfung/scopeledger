/** Reviewed PostgreSQL SQL. Persists synthetic analysis evidence and human review only. */
export const migration003 = `
CREATE TABLE analysis_scopes (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'synthetic-provider-analysis'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id),
  CHECK (
    workspace_id = 'demo-provider-workspace'
    AND project_id = 'synthetic-pdf-review'
  )
);
INSERT INTO analysis_scopes(workspace_id,project_id,purpose)
  VALUES ('demo-provider-workspace','synthetic-pdf-review','synthetic-provider-analysis');
CREATE TRIGGER immutable_analysis_scope
  BEFORE UPDATE OR DELETE ON analysis_scopes
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE analysis_source_identities (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind = 'provider-upload'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,source_id),
  FOREIGN KEY (workspace_id,project_id)
    REFERENCES analysis_scopes(workspace_id,project_id),
  CHECK (
    source_id = 'provider-upload'
    AND char_length(source_id) BETWEEN 1 AND 96
  )
);
INSERT INTO analysis_source_identities(
  workspace_id,project_id,source_id,source_kind
) VALUES (
  'demo-provider-workspace','synthetic-pdf-review','provider-upload','provider-upload'
);
CREATE TRIGGER immutable_analysis_source_identity
  BEFORE UPDATE OR DELETE ON analysis_source_identities
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE analysis_source_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  version_id uuid NOT NULL,
  exact_text text NOT NULL,
  exact_text_digest text NOT NULL CHECK (exact_text_digest ~ '^[a-f0-9]{64}$'),
  parser_reference text NOT NULL CHECK (
    char_length(parser_reference) BETWEEN 1 AND 128
    AND parser_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  extraction_status text NOT NULL CHECK (extraction_status IN ('complete','partial')),
  declared_byte_length integer NOT NULL CHECK (declared_byte_length BETWEEN 1 AND 10000000),
  declared_page_count integer NOT NULL CHECK (declared_page_count BETWEEN 1 AND 50),
  extracted_page_count integer NOT NULL CHECK (
    extracted_page_count BETWEEN 1 AND declared_page_count
  ),
  code_point_count integer NOT NULL CHECK (code_point_count BETWEEN 1 AND 200000),
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,project_id,source_id,version_id),
  FOREIGN KEY (workspace_id,project_id,source_id)
    REFERENCES analysis_source_identities(workspace_id,project_id,source_id),
  CHECK (char_length(exact_text) = code_point_count),
  CHECK (
    encode(sha256(convert_to(exact_text,'UTF8')),'hex') = exact_text_digest
  ),
  CHECK (
    (extraction_status = 'complete' AND extracted_page_count = declared_page_count)
    OR extraction_status = 'partial'
  )
);

CREATE TABLE analysis_source_provenance (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  version_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin = 'other'),
  supplied_by text NOT NULL CHECK (supplied_by = 'authenticated-provider'),
  content_attestation text NOT NULL CHECK (
    content_attestation = 'synthetic-or-permitted'
  ),
  attested_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,project_id,source_id,version_id),
  FOREIGN KEY (workspace_id,project_id,source_id,version_id)
    REFERENCES analysis_source_versions(workspace_id,project_id,source_id,version_id)
);

CREATE TABLE analysis_source_permissions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  version_id uuid NOT NULL,
  studio_sharing text NOT NULL CHECK (studio_sharing = 'permitted'),
  model_processing text NOT NULL CHECK (model_processing IN ('permitted','denied')),
  model_input_review text NOT NULL CHECK (
    model_input_review IN ('cleared','not-reviewed')
  ),
  reviewed_by_subject_digest text CHECK (
    reviewed_by_subject_digest IS NULL
    OR reviewed_by_subject_digest ~ '^[a-f0-9]{64}$'
  ),
  reviewed_at timestamptz,
  PRIMARY KEY (workspace_id,project_id,source_id,version_id),
  FOREIGN KEY (workspace_id,project_id,source_id,version_id)
    REFERENCES analysis_source_versions(workspace_id,project_id,source_id,version_id),
  CHECK (
    (
      model_processing = 'permitted'
      AND model_input_review = 'cleared'
      AND reviewed_by_subject_digest IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
    OR (
      model_processing = 'denied'
      AND model_input_review = 'not-reviewed'
      AND reviewed_by_subject_digest IS NULL
      AND reviewed_at IS NULL
    )
  )
);

CREATE TABLE analysis_source_coverage (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  version_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 50),
  status text NOT NULL CHECK (status IN ('extracted','unavailable')),
  start_offset integer,
  end_offset integer,
  reason_code text,
  PRIMARY KEY (workspace_id,project_id,source_id,version_id,page_number),
  FOREIGN KEY (workspace_id,project_id,source_id,version_id)
    REFERENCES analysis_source_versions(workspace_id,project_id,source_id,version_id),
  CHECK (
    (
      status = 'extracted'
      AND start_offset IS NOT NULL
      AND end_offset IS NOT NULL
      AND start_offset >= 0
      AND end_offset > start_offset
      AND reason_code IS NULL
    )
    OR (
      status = 'unavailable'
      AND start_offset IS NULL
      AND end_offset IS NULL
      AND reason_code = 'parser-reported-unavailable'
    )
  )
);

CREATE FUNCTION require_complete_analysis_source_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_row analysis_source_versions%ROWTYPE;
  coverage_count integer;
  extracted_count integer;
  first_page integer;
  last_page integer;
  final_offset integer;
BEGIN
  SELECT * INTO version_row
  FROM analysis_source_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND source_id = NEW.source_id
    AND version_id = NEW.version_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM analysis_source_provenance
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND source_id = NEW.source_id
      AND version_id = NEW.version_id
      AND content_attestation = 'synthetic-or-permitted'
  ) OR NOT EXISTS (
    SELECT 1 FROM analysis_source_permissions
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND source_id = NEW.source_id
      AND version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION 'analysis source requires attested provenance and permissions'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer,
      count(*) FILTER (WHERE status = 'extracted')::integer,
      min(page_number),
      max(page_number)
    INTO coverage_count,extracted_count,first_page,last_page
  FROM analysis_source_coverage
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND source_id = NEW.source_id
    AND version_id = NEW.version_id;
  IF coverage_count <> version_row.declared_page_count
    OR extracted_count <> version_row.extracted_page_count
    OR first_page <> 1
    OR last_page <> version_row.declared_page_count THEN
    RAISE EXCEPTION 'analysis source coverage inventory is incomplete'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH extracted AS (
      SELECT start_offset,end_offset,
        lag(end_offset) OVER (ORDER BY page_number) AS prior_end
      FROM analysis_source_coverage
      WHERE workspace_id = NEW.workspace_id
        AND project_id = NEW.project_id
        AND source_id = NEW.source_id
        AND version_id = NEW.version_id
        AND status = 'extracted'
    )
    SELECT 1 FROM extracted
    WHERE start_offset <> coalesce(prior_end,0)
  ) THEN
    RAISE EXCEPTION 'analysis source extracted ranges are not contiguous'
      USING ERRCODE = '23514';
  END IF;
  SELECT end_offset INTO final_offset
  FROM analysis_source_coverage
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND source_id = NEW.source_id
    AND version_id = NEW.version_id
    AND status = 'extracted'
  ORDER BY page_number DESC
  LIMIT 1;
  IF final_offset IS DISTINCT FROM version_row.code_point_count THEN
    RAISE EXCEPTION 'analysis source coverage does not match exact text'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_analysis_source_version
  AFTER INSERT ON analysis_source_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_analysis_source_version();

CREATE TRIGGER immutable_analysis_source_version
  BEFORE UPDATE OR DELETE ON analysis_source_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_analysis_source_provenance
  BEFORE UPDATE OR DELETE ON analysis_source_provenance
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_analysis_source_permissions
  BEFORE UPDATE OR DELETE ON analysis_source_permissions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_analysis_source_coverage
  BEFORE UPDATE OR DELETE ON analysis_source_coverage
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE analysis_runs (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  run_id uuid NOT NULL,
  requested_by_subject_digest text NOT NULL CHECK (
    requested_by_subject_digest ~ '^[a-f0-9]{64}$'
  ),
  source_id text NOT NULL,
  source_version_id uuid NOT NULL,
  provider_reference text NOT NULL CHECK (
    provider_reference IN ('manual','google-gemini')
  ),
  model_reference text CHECK (
    model_reference IS NULL
    OR (
      char_length(model_reference) BETWEEN 1 AND 128
      AND model_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
  ),
  candidate_schema_reference text NOT NULL CHECK (
    candidate_schema_reference = 'scopeledger.analysis-candidates.v1'
  ),
  config_reference text NOT NULL CHECK (
    config_reference IN (
      'scopeledger.analysis.manual.v1',
      'scopeledger.gemini.server-config.v1'
    )
  ),
  status text NOT NULL CHECK (
    status IN ('manual-review-ready','candidate-ready','model-failed')
  ),
  candidate_payload jsonb,
  candidate_digest text CHECK (
    candidate_digest IS NULL OR candidate_digest ~ '^[a-f0-9]{64}$'
  ),
  failure_code text CHECK (
    failure_code IS NULL OR failure_code IN (
      'MODEL_INPUT_NOT_ADMITTED',
      'MODEL_CONFIGURATION_UNAVAILABLE',
      'MODEL_PROCESSING_FAILED'
    )
  ),
  failure_message text CHECK (
    failure_message IS NULL
    OR (
      char_length(failure_message) BETWEEN 1 AND 320
      AND failure_message = btrim(failure_message)
      AND failure_message !~ '[[:cntrl:]]'
    )
  ),
  human_review_required boolean NOT NULL CHECK (human_review_required),
  publication_blocked boolean NOT NULL CHECK (publication_blocked),
  run_digest text NOT NULL CHECK (run_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,project_id,run_id),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version_id)
    REFERENCES analysis_source_versions(
      workspace_id,project_id,source_id,version_id
    ),
  UNIQUE (workspace_id,project_id,run_id,run_digest),
  CHECK (
    (
      status = 'manual-review-ready'
      AND provider_reference = 'manual'
      AND model_reference IS NULL
      AND config_reference = 'scopeledger.analysis.manual.v1'
      AND candidate_payload IS NULL
      AND candidate_digest IS NULL
      AND failure_code IS NULL
      AND failure_message IS NULL
    )
    OR (
      status = 'candidate-ready'
      AND provider_reference = 'google-gemini'
      AND model_reference IS NOT NULL
      AND config_reference = 'scopeledger.gemini.server-config.v1'
      AND jsonb_typeof(candidate_payload) = 'object'
      AND candidate_payload->>'schemaReference' = 'scopeledger.analysis-candidates.v1'
      AND candidate_payload->>'humanReviewRequired' = 'true'
      AND candidate_payload->>'publicationBlocked' = 'true'
      AND jsonb_typeof(candidate_payload->'candidates') = 'array'
      AND jsonb_array_length(candidate_payload->'candidates') BETWEEN 1 AND 40
      AND candidate_digest IS NOT NULL
      AND failure_code IS NULL
      AND failure_message IS NULL
    )
    OR (
      status = 'model-failed'
      AND provider_reference = 'google-gemini'
      AND config_reference = 'scopeledger.gemini.server-config.v1'
      AND candidate_payload IS NULL
      AND candidate_digest IS NULL
      AND failure_code IS NOT NULL
      AND failure_message IS NOT NULL
    )
  )
);
CREATE INDEX analysis_runs_latest_by_provider
  ON analysis_runs(
    workspace_id,project_id,requested_by_subject_digest,created_at DESC,run_id DESC
  );
CREATE TRIGGER immutable_analysis_run
  BEFORE UPDATE OR DELETE ON analysis_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE analysis_human_reviews (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  review_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reviewer_subject_digest text NOT NULL CHECK (
    reviewer_subject_digest ~ '^[a-f0-9]{64}$'
  ),
  reviewed_at timestamptz NOT NULL,
  disposition text NOT NULL CHECK (
    disposition IN ('accept','edit','reject','manual')
  ),
  note text NOT NULL CHECK (
    char_length(note) BETWEEN 1 AND 2000
    AND note = btrim(note)
    AND translate(note, E'\\n\\t', '') !~ '[[:cntrl:]]'
  ),
  run_basis_digest text NOT NULL CHECK (run_basis_digest ~ '^[a-f0-9]{64}$'),
  candidate_basis_digest text CHECK (
    candidate_basis_digest IS NULL
    OR candidate_basis_digest ~ '^[a-f0-9]{64}$'
  ),
  PRIMARY KEY (workspace_id,project_id,review_id),
  FOREIGN KEY (workspace_id,project_id,run_id)
    REFERENCES analysis_runs(workspace_id,project_id,run_id)
);
CREATE INDEX analysis_human_reviews_by_run
  ON analysis_human_reviews(workspace_id,project_id,run_id,reviewed_at,review_id);

CREATE FUNCTION protect_analysis_review_basis() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_row analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_row
  FROM analysis_runs
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND run_id = NEW.run_id;
  IF NOT FOUND
    OR NEW.reviewer_subject_digest IS DISTINCT FROM run_row.requested_by_subject_digest
    OR NEW.run_basis_digest IS DISTINCT FROM run_row.run_digest
    OR NEW.candidate_basis_digest IS DISTINCT FROM run_row.candidate_digest
    OR NEW.reviewed_at < run_row.created_at THEN
    RAISE EXCEPTION 'human review requires the immutable owned run basis'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_analysis_review_basis
  BEFORE INSERT ON analysis_human_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_analysis_review_basis();
CREATE TRIGGER immutable_analysis_human_review
  BEFORE UPDATE OR DELETE ON analysis_human_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

INSERT INTO schema_migrations(version) VALUES (3);
`;
