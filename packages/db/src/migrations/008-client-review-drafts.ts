/** Reviewed PostgreSQL SQL. Adds private, expiring client review drafts only. */
export const migration008 = `
CREATE FUNCTION client_review_draft_digest(
  workspace_id text,
  project_id text,
  request_id text,
  unit_id text,
  participant_subject_digest text,
  actor_id text,
  nomination_epoch integer,
  kind text,
  exact_text text,
  correction_source_text text,
  model_processing text
) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(
    jsonb_build_object(
      'workspaceId',workspace_id,
      'projectId',project_id,
      'requestId',request_id,
      'unitId',unit_id,
      'participantSubjectDigest',participant_subject_digest,
      'actorId',actor_id,
      'nominationEpoch',nomination_epoch,
      'kind',kind,
      'exactText',exact_text,
      'correctionSourceText',correction_source_text,
      'modelProcessing',model_processing
    )::text,
    'UTF8'
  )),'hex')
$$;

CREATE TABLE client_review_drafts (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  unit_id text NOT NULL,
  participant_subject_digest text NOT NULL CHECK (
    participant_subject_digest ~ '^[a-f0-9]{64}$'
  ),
  actor_id text NOT NULL CHECK (
    actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
  ),
  nomination_epoch integer NOT NULL CHECK (nomination_epoch > 0),
  kind text NOT NULL CHECK (kind IN ('question','correction')),
  revision integer NOT NULL CHECK (revision > 0),
  exact_text text NOT NULL CHECK (
    authoring_text_is_valid(exact_text,10000,false,true)
    AND exact_text ~ '[^[:space:]]'
  ),
  correction_source_text text CHECK (
    correction_source_text IS NULL
    OR (
      authoring_text_is_valid(correction_source_text,10000,false,true)
      AND correction_source_text ~ '[^[:space:]]'
    )
  ),
  model_processing text NOT NULL CHECK (
    model_processing IN ('permitted','denied')
  ),
  draft_digest text NOT NULL CHECK (draft_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (
    workspace_id,project_id,request_id,unit_id,
    participant_subject_digest,actor_id,nomination_epoch,kind
  ),
  FOREIGN KEY (workspace_id,project_id,unit_id,request_id)
    REFERENCES units(workspace_id,project_id,id,packet_id),
  CHECK (
    (kind = 'question' AND correction_source_text IS NULL)
    OR kind = 'correction'
  ),
  CHECK (updated_at >= created_at),
  CHECK (expires_at = updated_at + interval '7 days'),
  CHECK (
    draft_digest = client_review_draft_digest(
      workspace_id,project_id,request_id,unit_id,
      participant_subject_digest,actor_id,nomination_epoch,kind,
      exact_text,coalesce(correction_source_text,''),model_processing
    )
  )
);

CREATE FUNCTION protect_client_review_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
    OR NEW.participant_subject_digest IS DISTINCT FROM OLD.participant_subject_digest
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.nomination_epoch IS DISTINCT FROM OLD.nomination_epoch
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'client review draft scope cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision = OLD.revision THEN
    IF NEW.exact_text IS DISTINCT FROM OLD.exact_text
      OR NEW.correction_source_text IS DISTINCT FROM OLD.correction_source_text
      OR NEW.model_processing IS DISTINCT FROM OLD.model_processing
      OR NEW.draft_digest IS DISTINCT FROM OLD.draft_digest THEN
      RAISE EXCEPTION 'same draft revision cannot change content'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision = OLD.revision + 1 THEN
    IF NEW.exact_text IS NOT DISTINCT FROM OLD.exact_text
      AND NEW.correction_source_text IS NOT DISTINCT FROM OLD.correction_source_text
      AND NEW.model_processing IS NOT DISTINCT FROM OLD.model_processing THEN
      RAISE EXCEPTION 'changed draft revision requires changed content'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'client review draft revisions must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stable_client_review_draft
  BEFORE UPDATE ON client_review_drafts
  FOR EACH ROW EXECUTE FUNCTION protect_client_review_draft();

CREATE INDEX client_review_drafts_by_expiry
  ON client_review_drafts(expires_at);

INSERT INTO schema_migrations(version) VALUES (8);
`;
