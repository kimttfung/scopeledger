/** Reviewed PostgreSQL SQL. Adds immutable provider preparation and publication provenance only. */
export const migration005 = `
CREATE FUNCTION commercial_money_is_valid(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT value ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    AND value::numeric BETWEEN 0 AND 9999999999.99
$$;

CREATE TABLE provider_commercial_preparations (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  request_id text NOT NULL,
  unit_id text NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  draft_digest text NOT NULL CHECK (draft_digest ~ '^[a-f0-9]{64}$'),
  treatment text NOT NULL CHECK (
    treatment IN ('included','waived','payable','unresolved')
  ),
  independence_explanation text NOT NULL CHECK (
    authoring_text_is_valid(independence_explanation,10000,false,true)
    AND independence_explanation ~ '[^[:space:]]'
  ),
  client_visible_rationale text NOT NULL CHECK (
    authoring_text_is_valid(client_visible_rationale,10000,false,true)
    AND client_visible_rationale ~ '[^[:space:]]'
  ),
  delivery_description text NOT NULL CHECK (
    authoring_text_is_valid(delivery_description,10000,false,true)
    AND delivery_description ~ '[^[:space:]]'
  ),
  payment_explanation text NOT NULL CHECK (
    authoring_text_is_valid(payment_explanation,10000,false,true)
    AND payment_explanation ~ '[^[:space:]]'
  ),
  consent_requirement text NOT NULL CHECK (
    consent_requirement IN ('required','not-required','not-applicable')
  ),
  payment_policy text NOT NULL CHECK (
    payment_policy IN ('full-prepayment','not-required')
  ),
  currency text CHECK (currency IS NULL OR currency = 'USD'),
  subtotal text CHECK (
    subtotal IS NULL OR commercial_money_is_valid(subtotal)
  ),
  tax_treatment text NOT NULL CHECK (
    tax_treatment IN (
      'none','exclusive','inclusive','not-applicable','unresolved'
    )
  ),
  tax_amount text NOT NULL CHECK (commercial_money_is_valid(tax_amount)),
  tax_declaration text NOT NULL CHECK (
    authoring_text_is_valid(tax_declaration,10000,false,true)
    AND tax_declaration ~ '[^[:space:]]'
  ),
  gross text CHECK (gross IS NULL OR commercial_money_is_valid(gross)),
  merchant_id text NOT NULL CHECK (
    merchant_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  client_id text NOT NULL CHECK (
    client_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  approver_id text NOT NULL CHECK (
    approver_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  nomination_epoch integer NOT NULL CHECK (nomination_epoch > 0),
  context_revision integer NOT NULL CHECK (context_revision > 0),
  expected_previous_version integer CHECK (expected_previous_version > 0),
  publication_readiness text NOT NULL CHECK (
    publication_readiness IN ('ready','blocked','not-applicable')
  ),
  source_count integer NOT NULL CHECK (source_count BETWEEN 1 AND 100),
  baseline_count integer NOT NULL CHECK (baseline_count BETWEEN 1 AND 100),
  dependency_count integer NOT NULL CHECK (dependency_count BETWEEN 0 AND 100),
  delivery_dependency_count integer NOT NULL CHECK (
    delivery_dependency_count BETWEEN 0 AND 100
  ),
  prerequisite_count integer NOT NULL CHECK (
    prerequisite_count BETWEEN 0 AND 100
  ),
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 100),
  prepared_by text NOT NULL CHECK (
    prepared_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  preparation_digest text NOT NULL CHECK (
    preparation_digest ~ '^[a-f0-9]{64}$'
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id),
  UNIQUE (workspace_id,project_id,unit_id,revision),
  UNIQUE (
    workspace_id,project_id,preparation_id,unit_id,draft_revision
  ),
  UNIQUE (workspace_id,project_id,preparation_id,unit_id),
  UNIQUE (
    workspace_id,project_id,unit_id,draft_revision,draft_digest,preparation_id
  ),
  FOREIGN KEY (workspace_id,project_id,unit_id,request_id)
    REFERENCES units(workspace_id,project_id,id,packet_id),
  FOREIGN KEY (
    workspace_id,project_id,unit_id,draft_revision,draft_digest
  ) REFERENCES provider_authoring_draft_versions(
    workspace_id,project_id,unit_id,revision,draft_digest
  ),
  CHECK (
    (
      treatment = 'payable'
      AND consent_requirement = 'required'
      AND payment_policy = 'full-prepayment'
      AND currency = 'USD'
      AND subtotal IS NOT NULL
      AND gross IS NOT NULL
      AND line_count BETWEEN 1 AND 100
      AND tax_treatment IN ('none','exclusive','inclusive')
      AND publication_readiness IN ('ready','blocked')
    )
    OR (
      treatment <> 'payable'
      AND payment_policy = 'not-required'
      AND currency IS NULL
      AND subtotal IS NULL
      AND gross IS NULL
      AND line_count = 0
      AND tax_amount = '0.00'
      AND (
        (
          treatment = 'waived'
          AND consent_requirement IN ('required','not-required')
          AND tax_treatment = 'not-applicable'
          AND publication_readiness IN ('ready','blocked')
        )
        OR (
          treatment = 'included'
          AND consent_requirement = 'not-applicable'
          AND tax_treatment = 'not-applicable'
          AND publication_readiness = 'not-applicable'
        )
        OR (
          treatment = 'unresolved'
          AND consent_requirement = 'not-applicable'
          AND tax_treatment IN ('not-applicable','unresolved')
          AND publication_readiness = 'blocked'
        )
      )
    )
  )
);

CREATE FUNCTION validate_commercial_preparation_basis() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_request text;
  actual_current_version integer;
  actual_client text;
  actual_approver text;
  actual_nomination_epoch integer;
  actual_context_revision integer;
  actual_merchant text;
  actual_environment text;
  actual_draft_state text;
  actual_draft_digest text;
  latest_draft_revision integer;
  latest_preparation_revision integer;
BEGIN
  SELECT u.packet_id,u.current_version,p.client_id,p.approver_id,
      p.nomination_epoch,p.context_revision,w.merchant_id,w.environment
    INTO actual_request,actual_current_version,actual_client,actual_approver,
      actual_nomination_epoch,actual_context_revision,actual_merchant,
      actual_environment
  FROM units u
  JOIN projects p
    ON p.workspace_id = u.workspace_id AND p.id = u.project_id
  JOIN workspaces w ON w.id = u.workspace_id
  WHERE u.workspace_id = NEW.workspace_id
    AND u.project_id = NEW.project_id
    AND u.id = NEW.unit_id
  FOR SHARE OF p,w
  FOR UPDATE OF u;
  IF NOT FOUND
    OR actual_request IS DISTINCT FROM NEW.request_id
    OR actual_current_version IS DISTINCT FROM NEW.expected_previous_version
    OR actual_client IS DISTINCT FROM NEW.client_id
    OR actual_approver IS DISTINCT FROM NEW.approver_id
    OR actual_nomination_epoch IS DISTINCT FROM NEW.nomination_epoch
    OR actual_context_revision IS DISTINCT FROM NEW.context_revision
    OR actual_merchant IS DISTINCT FROM NEW.merchant_id
    OR actual_environment IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'commercial preparation server basis is stale or invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT d.state,d.draft_digest,
      (
        SELECT max(d2.revision)::integer
        FROM provider_authoring_draft_versions d2
        WHERE d2.workspace_id = d.workspace_id
          AND d2.project_id = d.project_id
          AND d2.unit_id = d.unit_id
      )
    INTO actual_draft_state,actual_draft_digest,latest_draft_revision
  FROM provider_authoring_draft_versions d
  WHERE d.workspace_id = NEW.workspace_id
    AND d.project_id = NEW.project_id
    AND d.request_id = NEW.request_id
    AND d.unit_id = NEW.unit_id
    AND d.revision = NEW.draft_revision;
  IF NOT FOUND
    OR actual_draft_state <> 'ready-for-client-review'
    OR actual_draft_digest IS DISTINCT FROM NEW.draft_digest
    OR latest_draft_revision IS DISTINCT FROM NEW.draft_revision THEN
    RAISE EXCEPTION 'commercial preparation requires the latest exact draft'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(revision)::integer INTO latest_preparation_revision
  FROM provider_commercial_preparations
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND unit_id = NEW.unit_id;
  IF NEW.revision <> coalesce(latest_preparation_revision,0) + 1 THEN
    RAISE EXCEPTION 'commercial preparation revisions must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_commercial_preparation_basis
  BEFORE INSERT ON provider_commercial_preparations
  FOR EACH ROW EXECUTE FUNCTION validate_commercial_preparation_basis();

CREATE TABLE provider_commercial_preparation_sources (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  unit_id text NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  source_id text NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_record_digest text NOT NULL CHECK (
    source_record_digest ~ '^[a-f0-9]{64}$'
  ),
  locator text NOT NULL CHECK (
    authoring_text_is_valid(locator,10000,false,true)
    AND locator ~ '[^[:space:]]'
  ),
  materiality text NOT NULL CHECK (
    materiality IN ('material','supporting')
  ),
  coverage_status text NOT NULL CHECK (
    coverage_status IN ('covered','unresolved')
  ),
  analysis_status text NOT NULL CHECK (
    analysis_status IN (
      'not-used','human-reviewed','model-output-reviewed','unresolved'
    )
  ),
  analysis_reference text CHECK (
    analysis_reference IS NULL
    OR authoring_text_is_valid(analysis_reference,2000,false,true)
  ),
  explanation text NOT NULL CHECK (
    authoring_text_is_valid(explanation,10000,false,true)
    AND explanation ~ '[^[:space:]]'
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  UNIQUE (
    workspace_id,project_id,preparation_id,source_id,source_version
  ),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    ),
  FOREIGN KEY (
    workspace_id,project_id,preparation_id,unit_id,draft_revision
  ) REFERENCES provider_commercial_preparations(
    workspace_id,project_id,preparation_id,unit_id,draft_revision
  ),
  FOREIGN KEY (
    workspace_id,project_id,unit_id,draft_revision,source_id,source_version
  ) REFERENCES provider_authoring_draft_sources(
    workspace_id,project_id,unit_id,draft_revision,source_id,source_version
  ),
  FOREIGN KEY (workspace_id,project_id,source_id,source_version)
    REFERENCES source_intake_records(
      workspace_id,project_id,source_id,source_version
    ),
  CHECK (
      (
        analysis_status <> 'model-output-reviewed'
        OR analysis_reference IS NOT NULL
      )
      AND (
        analysis_status NOT IN ('not-used','unresolved')
        OR analysis_reference IS NULL
      )
  )
);

CREATE TABLE provider_commercial_preparation_baselines (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  baseline_id text NOT NULL,
  baseline_version integer NOT NULL CHECK (baseline_version > 0),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  UNIQUE (
    workspace_id,project_id,preparation_id,baseline_id,baseline_version
  ),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    ),
  FOREIGN KEY (workspace_id,project_id,baseline_id,baseline_version)
    REFERENCES baseline_versions(workspace_id,project_id,id,version)
);

CREATE TABLE provider_commercial_preparation_dependencies (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  unit_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  dependency_unit_id text NOT NULL,
  explanation text NOT NULL CHECK (
    authoring_text_is_valid(explanation,10000,false,true)
    AND explanation ~ '[^[:space:]]'
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  UNIQUE (workspace_id,project_id,preparation_id,dependency_unit_id),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    ),
  FOREIGN KEY (workspace_id,project_id,preparation_id,unit_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id,unit_id
    ),
  FOREIGN KEY (workspace_id,project_id,dependency_unit_id)
    REFERENCES units(workspace_id,project_id,id),
  CHECK (dependency_unit_id <> unit_id)
);

CREATE TABLE provider_commercial_preparation_delivery_dependencies (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  description text NOT NULL CHECK (
    authoring_text_is_valid(description,10000,false,true)
    AND description ~ '[^[:space:]]'
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    )
);

CREATE TABLE provider_commercial_preparation_prerequisites (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  prerequisite_id text NOT NULL CHECK (
    prerequisite_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  prerequisite_version integer NOT NULL CHECK (prerequisite_version > 0),
  description text NOT NULL CHECK (
    authoring_text_is_valid(description,10000,false,true)
    AND description ~ '[^[:space:]]'
  ),
  blocks text NOT NULL CHECK (
    blocks IN ('payment','start','payment-and-start')
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  UNIQUE (workspace_id,project_id,preparation_id,prerequisite_id),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    )
);

CREATE TABLE provider_commercial_preparation_lines (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  line_id text NOT NULL CHECK (
    line_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  description text NOT NULL CHECK (
    authoring_text_is_valid(description,10000,false,true)
    AND description ~ '[^[:space:]]'
  ),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999999),
  unit_price text NOT NULL CHECK (
    commercial_money_is_valid(unit_price)
    AND unit_price::numeric > 0
  ),
  amount text NOT NULL CHECK (
    commercial_money_is_valid(amount)
    AND amount::numeric > 0
    AND amount::numeric = unit_price::numeric * quantity
  ),
  PRIMARY KEY (workspace_id,project_id,preparation_id,position),
  UNIQUE (workspace_id,project_id,preparation_id,line_id),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    )
);

CREATE FUNCTION require_complete_commercial_preparation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_workspace text;
  target_project text;
  target_preparation uuid;
  preparation provider_commercial_preparations%ROWTYPE;
  actual_sources integer;
  actual_baselines integer;
  actual_dependencies integer;
  actual_delivery_dependencies integer;
  actual_prerequisites integer;
  actual_lines integer;
  line_total numeric;
  material_blockers integer;
  source_basis_mismatches integer;
  draft_source_count integer;
  first_source_position integer;
  last_source_position integer;
BEGIN
  target_workspace := NEW.workspace_id;
  target_project := NEW.project_id;
  target_preparation := NEW.preparation_id;
  SELECT * INTO preparation
  FROM provider_commercial_preparations
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer,min(position),max(position)
    INTO actual_sources,first_source_position,last_source_position
  FROM provider_commercial_preparation_sources
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  SELECT source_count INTO draft_source_count
  FROM provider_authoring_draft_versions
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND unit_id = preparation.unit_id
    AND revision = preparation.draft_revision;
  SELECT count(*)::integer INTO actual_baselines
  FROM provider_commercial_preparation_baselines
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  SELECT count(*)::integer INTO actual_dependencies
  FROM provider_commercial_preparation_dependencies
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  SELECT count(*)::integer INTO actual_delivery_dependencies
  FROM provider_commercial_preparation_delivery_dependencies
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  SELECT count(*)::integer INTO actual_prerequisites
  FROM provider_commercial_preparation_prerequisites
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;
  SELECT count(*)::integer,coalesce(sum(amount::numeric),0)
    INTO actual_lines,line_total
  FROM provider_commercial_preparation_lines
  WHERE workspace_id = target_workspace
    AND project_id = target_project
    AND preparation_id = target_preparation;

  IF actual_sources <> preparation.source_count
    OR draft_source_count <> preparation.source_count
    OR first_source_position <> 1
    OR last_source_position <> preparation.source_count
    OR actual_baselines <> preparation.baseline_count
    OR actual_dependencies <> preparation.dependency_count
    OR actual_delivery_dependencies <> preparation.delivery_dependency_count
    OR actual_prerequisites <> preparation.prerequisite_count
    OR actual_lines <> preparation.line_count THEN
    RAISE EXCEPTION 'commercial preparation inventory is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF preparation.treatment = 'payable' THEN
    IF line_total <> preparation.subtotal::numeric
      OR line_total <= 0
      OR line_total > 9999999999.99
      OR (
        preparation.tax_treatment = 'exclusive'
        AND preparation.gross::numeric <>
          preparation.subtotal::numeric + preparation.tax_amount::numeric
      )
      OR (
        preparation.tax_treatment IN ('none','inclusive')
        AND preparation.gross::numeric <> preparation.subtotal::numeric
      )
      OR (
        preparation.tax_treatment = 'none'
        AND preparation.tax_amount <> '0.00'
      )
      OR (
        preparation.tax_treatment = 'inclusive'
        AND preparation.tax_amount::numeric > preparation.subtotal::numeric
      )
      OR preparation.gross::numeric <= 0
      OR preparation.gross::numeric > 9999999999.99 THEN
      RAISE EXCEPTION 'commercial preparation financial arithmetic is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT count(*)::integer INTO source_basis_mismatches
  FROM provider_commercial_preparation_sources pcs
  JOIN source_intake_records sir
    ON sir.workspace_id = pcs.workspace_id
    AND sir.project_id = pcs.project_id
    AND sir.source_id = pcs.source_id
    AND sir.source_version = pcs.source_version
  JOIN source_versions sv
    ON sv.workspace_id = pcs.workspace_id
    AND sv.project_id = pcs.project_id
    AND sv.id = pcs.source_id
    AND sv.version = pcs.source_version
  WHERE pcs.workspace_id = target_workspace
    AND pcs.project_id = target_project
    AND pcs.preparation_id = target_preparation
    AND pcs.source_record_digest IS DISTINCT FROM sir.record_digest;
  IF source_basis_mismatches > 0 THEN
    RAISE EXCEPTION 'commercial preparation source basis is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO material_blockers
  FROM provider_commercial_preparation_sources pcs
  JOIN source_intake_records sir
    ON sir.workspace_id = pcs.workspace_id
    AND sir.project_id = pcs.project_id
    AND sir.source_id = pcs.source_id
    AND sir.source_version = pcs.source_version
  JOIN source_versions sv
    ON sv.workspace_id = pcs.workspace_id
    AND sv.project_id = pcs.project_id
    AND sv.id = pcs.source_id
    AND sv.version = pcs.source_version
  WHERE pcs.workspace_id = target_workspace
    AND pcs.project_id = target_project
    AND pcs.preparation_id = target_preparation
    AND pcs.materiality = 'material'
    AND (
      pcs.coverage_status <> 'covered'
      OR pcs.analysis_status = 'unresolved'
      OR sv.availability <> 'available'
      OR sir.studio_sharing <> 'permitted'
      OR sir.acceptance_kind = 'unverified'
      OR (
        pcs.analysis_status = 'model-output-reviewed'
        AND (
          sir.model_processing <> 'permitted'
          OR sir.model_input_review_status <> 'cleared'
        )
      )
    );
  IF material_blockers > 0
    AND preparation.publication_readiness = 'ready' THEN
    RAISE EXCEPTION 'material source coverage or permission remains unresolved'
      USING ERRCODE = '23514';
  END IF;
  IF material_blockers = 0
    AND preparation.treatment IN ('waived','payable')
    AND preparation.publication_readiness <> 'ready' THEN
    RAISE EXCEPTION 'publishable preparation readiness is inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER complete_commercial_preparation
  AFTER INSERT ON provider_commercial_preparations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_sources
  AFTER INSERT ON provider_commercial_preparation_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_baselines
  AFTER INSERT ON provider_commercial_preparation_baselines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_dependencies
  AFTER INSERT ON provider_commercial_preparation_dependencies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_delivery
  AFTER INSERT ON provider_commercial_preparation_delivery_dependencies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_prerequisites
  AFTER INSERT ON provider_commercial_preparation_prerequisites
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();
CREATE CONSTRAINT TRIGGER complete_commercial_preparation_lines
  AFTER INSERT ON provider_commercial_preparation_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_complete_commercial_preparation();

CREATE TABLE provider_publication_provenance (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  preparation_id uuid NOT NULL,
  publication_command_id uuid NOT NULL,
  unit_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  published_by text NOT NULL CHECK (
    published_by ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,project_id,preparation_id),
  UNIQUE (
    workspace_id,project_id,published_by,publication_command_id
  ),
  UNIQUE (workspace_id,project_id,unit_id,version),
  FOREIGN KEY (workspace_id,project_id,preparation_id)
    REFERENCES provider_commercial_preparations(
      workspace_id,project_id,preparation_id
    ),
  FOREIGN KEY (workspace_id,project_id,unit_id,version)
    REFERENCES unit_versions(workspace_id,project_id,unit_id,version)
);

CREATE FUNCTION validate_provider_publication_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  preparation provider_commercial_preparations%ROWTYPE;
  publication unit_versions%ROWTYPE;
BEGIN
  SELECT * INTO preparation
  FROM provider_commercial_preparations
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND preparation_id = NEW.preparation_id;
  SELECT * INTO publication
  FROM unit_versions
  WHERE workspace_id = NEW.workspace_id
    AND project_id = NEW.project_id
    AND unit_id = NEW.unit_id
    AND version = NEW.version;
  IF preparation.preparation_id IS NULL
    OR publication.unit_id IS NULL
    OR preparation.unit_id IS DISTINCT FROM NEW.unit_id
    OR preparation.publication_readiness <> 'ready'
    OR preparation.treatment NOT IN ('waived','payable')
    OR NEW.version IS DISTINCT FROM
      coalesce(preparation.expected_previous_version,0) + 1
    OR publication.digest IS DISTINCT FROM NEW.digest
    OR publication.published_by IS DISTINCT FROM NEW.published_by
    OR (
      preparation.treatment = 'waived'
      AND publication.snapshot->>'treatment' <> 'additional-waived'
    )
    OR (
      preparation.treatment = 'payable'
      AND (
        publication.snapshot->>'treatment' <> 'payable'
        OR publication.snapshot#>>'{payment,financial,merchantId}'
          IS DISTINCT FROM preparation.merchant_id
        OR publication.snapshot#>>'{payment,financial,environment}'
          IS DISTINCT FROM preparation.environment
        OR publication.snapshot#>>'{payment,financial,gross}'
          IS DISTINCT FROM preparation.gross
      )
    ) THEN
    RAISE EXCEPTION 'publication provenance must bind the exact prepared version'
      USING ERRCODE = '23514';
  END IF;
  NEW.published_at := publication.published_at;
  RETURN NEW;
END $$;
CREATE TRIGGER exact_provider_publication_provenance
  BEFORE INSERT ON provider_publication_provenance
  FOR EACH ROW EXECUTE FUNCTION validate_provider_publication_provenance();

CREATE TRIGGER immutable_provider_commercial_preparation
  BEFORE UPDATE OR DELETE ON provider_commercial_preparations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_source
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_sources
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_baseline
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_baselines
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_dependency
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_dependencies
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_delivery
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_delivery_dependencies
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_prerequisite
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_prerequisites
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_commercial_line
  BEFORE UPDATE OR DELETE ON provider_commercial_preparation_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_provider_publication_provenance
  BEFORE UPDATE OR DELETE ON provider_publication_provenance
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

INSERT INTO schema_migrations(version) VALUES (5);
`;
