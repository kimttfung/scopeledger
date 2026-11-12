/** Reviewed PostgreSQL SQL. Extends existing scoped identities for authoring; questions are communication-only. */
export const migration004 = `
ALTER TABLE projects
  ADD COLUMN provider_display_name text,
  ADD COLUMN provider_created_by text,
  ADD COLUMN provider_created_at timestamptz,
  ADD COLUMN provider_initial_client_id text,
  ADD COLUMN provider_initial_approver_id text,
  ADD COLUMN provider_creation_digest text,
  ADD CONSTRAINT provider_project_creation_shape CHECK (
    (
      provider_display_name IS NULL
      AND provider_created_by IS NULL
      AND provider_created_at IS NULL
      AND provider_initial_client_id IS NULL
      AND provider_initial_approver_id IS NULL
      AND provider_creation_digest IS NULL
    )
    OR (
      char_length(provider_display_name) BETWEEN 1 AND 200
      AND provider_display_name = btrim(provider_display_name)
      AND provider_display_name !~ '[[:cntrl:]]'
      AND provider_created_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
      AND provider_created_at IS NOT NULL
      AND provider_initial_client_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
      AND provider_initial_approver_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
      AND provider_creation_digest ~ '^[a-f0-9]{64}$'
    )
  );

CREATE FUNCTION protect_provider_project_creation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_creation_digest IS NOT NULL THEN
      RAISE EXCEPTION 'provider-created project identity cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.provider_display_name IS DISTINCT FROM OLD.provider_display_name
    OR NEW.provider_created_by IS DISTINCT FROM OLD.provider_created_by
    OR NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
    OR NEW.provider_initial_client_id IS DISTINCT FROM OLD.provider_initial_client_id
    OR NEW.provider_initial_approver_id IS DISTINCT FROM OLD.provider_initial_approver_id
    OR NEW.provider_creation_digest IS DISTINCT FROM OLD.provider_creation_digest THEN
    RAISE EXCEPTION 'provider-created project identity cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_provider_project_creation
  BEFORE UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION protect_provider_project_creation();

ALTER TABLE packets
  ADD COLUMN provider_title text,
  ADD COLUMN provider_created_by text,
  ADD COLUMN provider_created_at timestamptz,
  ADD COLUMN provider_creation_digest text,
  ADD CONSTRAINT provider_request_creation_shape CHECK (
    (
      provider_title IS NULL
      AND provider_created_by IS NULL
      AND provider_created_at IS NULL
      AND provider_creation_digest IS NULL
    )
    OR (
      char_length(provider_title) BETWEEN 1 AND 200
      AND provider_title = btrim(provider_title)
      AND provider_title !~ '[[:cntrl:]]'
      AND provider_created_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
      AND provider_created_at IS NOT NULL
      AND provider_creation_digest ~ '^[a-f0-9]{64}$'
    )
  );

CREATE FUNCTION protect_provider_request_creation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_creation_digest IS NOT NULL THEN
      RAISE EXCEPTION 'provider-created request identity cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.provider_title IS DISTINCT FROM OLD.provider_title
    OR NEW.provider_created_by IS DISTINCT FROM OLD.provider_created_by
    OR NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
    OR NEW.provider_creation_digest IS DISTINCT FROM OLD.provider_creation_digest THEN
    RAISE EXCEPTION 'provider-created request identity cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_provider_request_creation
  BEFORE UPDATE OR DELETE ON packets
  FOR EACH ROW EXECUTE FUNCTION protect_provider_request_creation();

ALTER TABLE units
  ADD CONSTRAINT units_request_identity
  UNIQUE (workspace_id,project_id,id,packet_id);

CREATE FUNCTION authoring_text_is_valid(
  value text,
  maximum_points integer,
  require_trimmed boolean,
  allow_lines boolean
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  inspected text;
BEGIN
  IF char_length(value) < 1 OR char_length(value) > maximum_points THEN
    RETURN false;
  END IF;
  IF require_trimmed AND value <> btrim(value) THEN
    RETURN false;
  END IF;
  inspected := CASE WHEN allow_lines THEN translate(value, E'\\n\\t', '') ELSE value END;
  RETURN inspected !~ '[[:cntrl:]]';
END $$;

CREATE FUNCTION authoring_text_array_is_valid(
  value jsonb,
  minimum_items integer,
  maximum_items integer,
  maximum_points integer
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  item jsonb;
  item_count integer;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN
    RETURN false;
  END IF;
  item_count := jsonb_array_length(value);
  IF item_count < minimum_items OR item_count > maximum_items THEN
    RETURN false;
  END IF;
  FOR item IN SELECT entry FROM jsonb_array_elements(value) AS entries(entry)
  LOOP
    IF jsonb_typeof(item) <> 'string'
      OR NOT authoring_text_is_valid(item #>> '{}', maximum_points, true, true) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE source_intake_records (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_kind text NOT NULL CHECK (source_kind IN (
    'provider-upload','provider-note','client-supplied','external-reference'
  )),
  media_type text NOT NULL CHECK (
    char_length(media_type) BETWEEN 3 AND 192
    AND media_type ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}/[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$'
  ),
  original_name text CHECK (
    original_name IS NULL
    OR (
      char_length(original_name) BETWEEN 1 AND 255
      AND original_name = btrim(original_name)
      AND original_name !~ '[[:cntrl:]]'
    )
  ),
  declared_byte_length bigint NOT NULL CHECK (
    declared_byte_length BETWEEN 0 AND 10000000
  ),
  content_digest text CHECK (
    content_digest IS NULL OR content_digest ~ '^[a-f0-9]{64}$'
  ),
  provenance_origin text NOT NULL CHECK (provenance_origin IN (
    'agreement','amendment','correspondence','request',
    'prior-decision','correction','other'
  )),
  supplied_by text NOT NULL CHECK (
    supplied_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  origin_reference text CHECK (
    origin_reference IS NULL
    OR authoring_text_is_valid(origin_reference,2000,false,true)
  ),
  acceptance_kind text NOT NULL CHECK (acceptance_kind IN (
    'provider-attested-import','in-app-record-reference','unverified'
  )),
  acceptance_basis text NOT NULL CHECK (
    authoring_text_is_valid(acceptance_basis,2000,false,true)
  ),
  studio_sharing text NOT NULL CHECK (
    studio_sharing IN ('permitted','denied','unresolved')
  ),
  model_processing text NOT NULL CHECK (
    model_processing IN ('permitted','denied','unresolved')
  ),
  model_input_review_status text NOT NULL CHECK (
    model_input_review_status IN (
      'cleared','not-reviewed','unresolved','prohibited-financial-data'
    )
  ),
  model_reviewed_by text CHECK (
    model_reviewed_by IS NULL
    OR model_reviewed_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  model_reviewed_at timestamptz,
  model_review_basis text NOT NULL CHECK (
    authoring_text_is_valid(model_review_basis,2000,false,true)
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (workspace_id,project_id,source_id,source_version),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version)
    REFERENCES source_versions(workspace_id,project_id,id,version),
  CHECK (
    (
      declared_byte_length > 0
      AND content_digest IS NOT NULL
    )
    OR (
      declared_byte_length = 0
      AND content_digest IS NULL
    )
  ),
  CHECK (
    (
      model_input_review_status = 'cleared'
      AND model_processing = 'permitted'
      AND model_reviewed_by IS NOT NULL
      AND model_reviewed_at IS NOT NULL
    )
    OR (
      model_input_review_status <> 'cleared'
      AND model_reviewed_by IS NULL
      AND model_reviewed_at IS NULL
    )
  )
);
CREATE INDEX source_intake_by_project_time
  ON source_intake_records(workspace_id,project_id,recorded_at,source_id,source_version);
CREATE FUNCTION protect_source_intake_basis() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_availability text;
BEGIN
  SELECT availability INTO source_availability
  FROM source_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND id = NEW.source_id
    AND version = NEW.source_version;
  IF NOT FOUND
    OR (source_availability = 'available') IS DISTINCT FROM
      (NEW.declared_byte_length > 0) THEN
    RAISE EXCEPTION 'source intake must match its scoped source availability'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_source_intake_basis
  BEFORE INSERT ON source_intake_records
  FOR EACH ROW EXECUTE FUNCTION protect_source_intake_basis();
CREATE TRIGGER immutable_source_intake_record
  BEFORE UPDATE OR DELETE ON source_intake_records
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE provider_authoring_draft_versions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  unit_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('in-progress','ready-for-client-review')),
  title text NOT NULL CHECK (authoring_text_is_valid(title,200,true,false)),
  summary text NOT NULL CHECK (
    authoring_text_is_valid(summary,10000,false,true)
    AND summary ~ '[^[:space:]]'
  ),
  scope_items jsonb NOT NULL CHECK (
    authoring_text_array_is_valid(scope_items,1,100,10000)
  ),
  exclusion_items jsonb NOT NULL CHECK (
    authoring_text_array_is_valid(exclusion_items,0,100,10000)
  ),
  source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 100),
  draft_digest text NOT NULL CHECK (draft_digest ~ '^[a-f0-9]{64}$'),
  authored_by text NOT NULL CHECK (
    authored_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_id,unit_id,revision),
  UNIQUE (workspace_id,project_id,unit_id,revision,draft_digest),
  FOREIGN KEY (workspace_id,project_id,request_id)
    REFERENCES packets(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,unit_id,request_id)
    REFERENCES units(workspace_id,project_id,id,packet_id)
);

CREATE FUNCTION require_next_provider_draft_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  actual_request_id text;
BEGIN
  SELECT packet_id INTO actual_request_id
  FROM units
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND id = NEW.unit_id
  FOR UPDATE;
  IF NOT FOUND OR actual_request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION 'draft requires its scoped request unit'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM provider_authoring_draft_versions
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND unit_id = NEW.unit_id
      AND revision = NEW.revision
  ) THEN
    RETURN NEW;
  END IF;
  SELECT max(revision) INTO current_revision
  FROM provider_authoring_draft_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND unit_id = NEW.unit_id;
  IF NEW.revision <> coalesce(current_revision,0) + 1 THEN
    RAISE EXCEPTION 'draft revisions must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sequential_provider_draft_revision
  BEFORE INSERT ON provider_authoring_draft_versions
  FOR EACH ROW EXECUTE FUNCTION require_next_provider_draft_revision();
CREATE TRIGGER immutable_provider_draft_version
  BEFORE UPDATE OR DELETE ON provider_authoring_draft_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE provider_authoring_draft_sources (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  unit_id text NOT NULL,
  draft_revision integer NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  source_id text NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  PRIMARY KEY (workspace_id,project_id,unit_id,draft_revision,position),
  UNIQUE (
    workspace_id,project_id,unit_id,draft_revision,source_id,source_version
  ),
  FOREIGN KEY (workspace_id,project_id,unit_id,draft_revision)
    REFERENCES provider_authoring_draft_versions(
      workspace_id,project_id,unit_id,revision
    ),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version)
    REFERENCES source_versions(workspace_id,project_id,id,version)
);

CREATE FUNCTION require_complete_provider_draft_sources() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_workspace text;
  target_project text;
  target_unit text;
  target_revision integer;
  expected_count integer;
  actual_count integer;
  first_position integer;
  last_position integer;
BEGIN
  target_workspace := NEW.workspace_id;
  target_project := NEW.project_id;
  target_unit := NEW.unit_id;
  target_revision := coalesce(
    (to_jsonb(NEW)->>'revision')::integer,
    (to_jsonb(NEW)->>'draft_revision')::integer
  );
  SELECT source_count INTO expected_count
  FROM provider_authoring_draft_versions
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND unit_id = target_unit
    AND revision = target_revision;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*)::integer,min(position),max(position)
    INTO actual_count,first_position,last_position
  FROM provider_authoring_draft_sources
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND unit_id = target_unit
    AND draft_revision = target_revision;
  IF actual_count <> expected_count
    OR (
      expected_count > 0
      AND (first_position <> 1 OR last_position <> expected_count)
    ) THEN
    RAISE EXCEPTION 'draft source inventory is incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_provider_draft_sources
  AFTER INSERT ON provider_authoring_draft_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_provider_draft_sources();
CREATE CONSTRAINT TRIGGER stable_provider_draft_source_count
  AFTER INSERT ON provider_authoring_draft_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_provider_draft_sources();
CREATE TRIGGER immutable_provider_draft_source
  BEFORE UPDATE OR DELETE ON provider_authoring_draft_sources
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE client_questions (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  question_id uuid NOT NULL,
  request_id text NOT NULL,
  unit_id text NOT NULL,
  unit_version integer NOT NULL CHECK (unit_version > 0),
  asked_by text NOT NULL CHECK (
    asked_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  exact_text text NOT NULL CHECK (
    authoring_text_is_valid(exact_text,10000,false,true)
    AND exact_text ~ '[^[:space:]]'
  ),
  model_processing text NOT NULL CHECK (
    model_processing IN ('permitted','denied')
  ),
  communication_effect text NOT NULL DEFAULT 'communication-only'
    CHECK (communication_effect = 'communication-only'),
  asked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (workspace_id,project_id,question_id),
  FOREIGN KEY (workspace_id,project_id,unit_id,request_id)
    REFERENCES units(workspace_id,project_id,id,packet_id),
  FOREIGN KEY (workspace_id,project_id,unit_id,unit_version)
    REFERENCES unit_versions(workspace_id,project_id,unit_id,version)
);
CREATE INDEX client_questions_by_review_basis
  ON client_questions(
    workspace_id,project_id,request_id,unit_id,unit_version,asked_at,question_id
  );
CREATE TRIGGER immutable_client_question
  BEFORE UPDATE OR DELETE ON client_questions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

INSERT INTO schema_migrations(version) VALUES (4);
`;
