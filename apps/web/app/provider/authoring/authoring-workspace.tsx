"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  AuthoringDraft,
  AuthoringProject,
  AuthoringRequest,
} from "../../api/provider/authoring/service";
import type {
  ProviderSourceLimitState,
  ProviderSourceSummary,
} from "../../api/provider/sources/service";
import styles from "./authoring.module.css";
import BaselineConfirmationPanel from "./baseline-confirmation";
import CommercialWorkbench from "./commercial-workbench";
import ParticipantActivation from "./participant-activation";

type ProjectList = Readonly<{
  ok: true;
  projects: readonly AuthoringProject[];
}>;

type ProjectCreated = Readonly<{
  ok: true;
  project: AuthoringProject;
}>;

type RequestList = Readonly<{
  ok: true;
  requests: readonly AuthoringRequest[];
}>;

type RequestCreated = Readonly<{
  ok: true;
  request: AuthoringRequest;
}>;

type DraftList = Readonly<{
  ok: true;
  drafts: readonly AuthoringDraft[];
}>;

type DraftCreated = Readonly<{
  ok: true;
  draft: AuthoringDraft;
}>;

type SourceList = Readonly<{
  ok: true;
  sources: readonly ProviderSourceSummary[];
  limits: ProviderSourceLimitState;
}>;

type SourceUploaded = Readonly<{
  ok: true;
  duplicate: boolean;
  source: ProviderSourceSummary;
  limits: ProviderSourceLimitState;
}>;

const byteFormatter = new Intl.NumberFormat("en-US");

function count(value: string): number {
  return Array.from(value).length;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function sourceFileWithMediaType(file: File): File {
  if (file.type) return file;
  const name = file.name.toLowerCase();
  const type = name.endsWith(".pdf")
    ? "application/pdf"
    : name.endsWith(".md") || name.endsWith(".markdown")
      ? "text/markdown"
      : name.endsWith(".txt")
        ? "text/plain"
        : "";
  return type
    ? new File([file], file.name, { type, lastModified: file.lastModified })
    : file;
}

async function jsonResponse<T extends Readonly<{ ok: true }>>(
  response: Response,
): Promise<T> {
  const body = await response.json() as unknown;
  if (
    !body
    || typeof body !== "object"
    || !("ok" in body)
    || body.ok !== true
    || !response.ok
  ) {
    throw new Error(
      body
        && typeof body === "object"
        && "message" in body
        && typeof body.message === "string"
        ? body.message
        : "Provider authoring is unavailable.",
    );
  }
  return body as T;
}

export default function AuthoringWorkspace({
  initialSelection = null,
}: Readonly<{
  initialSelection?: Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
  }> | null;
}>) {
  const [projects, setProjects] = useState<readonly AuthoringProject[]>([]);
  const [requests, setRequests] = useState<readonly AuthoringRequest[]>([]);
  const [drafts, setDrafts] = useState<readonly AuthoringDraft[]>([]);
  const [sources, setSources] = useState<readonly ProviderSourceSummary[]>([]);
  const [sourceLimits, setSourceLimits] =
    useState<ProviderSourceLimitState | null>(null);
  const [selectedSourceLocators, setSelectedSourceLocators] = useState<
    readonly string[]
  >([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [requestTitle, setRequestTitle] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [exclusionsText, setExclusionsText] = useState("");
  const [reviewReady, setReviewReady] = useState(false);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [provenanceOrigin, setProvenanceOrigin] = useState("agreement");
  const [originReference, setOriginReference] = useState("");
  const [acceptanceBasis, setAcceptanceBasis] = useState("");
  const [contentAttestation, setContentAttestation] = useState(false);
  const [studioSharing, setStudioSharing] = useState("unresolved");
  const [modelProcessing, setModelProcessing] = useState("denied");
  const [modelInputReviewStatus, setModelInputReviewStatus] =
    useState("not-reviewed");
  const [modelReviewBasis, setModelReviewBasis] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((item) => item.projectId === projectId) ?? null;
  const selectedRequest = requests.find((item) => item.requestId === requestId)
    ?? null;
  const unitIds = useMemo(
    () => Array.from(new Set(drafts.map((draft) => draft.unitId))),
    [drafts],
  );
  const history = drafts.filter((draft) => draft.unitId === unitId);
  const latest = history.at(-1) ?? null;
  const selectedCorrectionContexts = latest?.correctionContexts ?? [];
  const modelPermissionMatchesReview =
    (modelProcessing === "permitted")
    === (modelInputReviewStatus === "cleared");

  function resetDraftForm(
    draft: AuthoringDraft | null,
    admittedLocators?: ReadonlySet<string>,
  ) {
    setTitle(draft?.title ?? "");
    setSummary(draft?.summary ?? "");
    setScopeText(draft?.scope.join("\n") ?? "");
    setExclusionsText(draft?.exclusions.join("\n") ?? "");
    setReviewReady(false);
    const locators = draft?.sourceReferences.map((source) => source.locator) ?? [];
    setSelectedSourceLocators(
      admittedLocators
        ? locators.filter((locator) => admittedLocators.has(locator))
        : locators,
    );
  }

  async function loadProjects(selectId?: string) {
    const response = await fetch("/api/provider/authoring/projects", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = await jsonResponse<ProjectList>(response);
    setProjects(body.projects);
    if (selectId) setProjectId(selectId);
  }

  async function loadRequests(targetProjectId: string, selectId?: string) {
    const response = await fetch(
      `/api/provider/authoring/projects/${encodeURIComponent(targetProjectId)}/requests`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
    const body = await jsonResponse<RequestList>(response);
    setRequests(body.requests);
    if (selectId) setRequestId(selectId);
  }

  async function loadDrafts(
    targetProjectId: string,
    targetRequestId: string,
    selectUnitId?: string,
    admittedLocators?: ReadonlySet<string>,
  ) {
    const response = await fetch(
      `/api/provider/authoring/projects/${encodeURIComponent(targetProjectId)}/requests/${encodeURIComponent(targetRequestId)}/drafts`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
    const body = await jsonResponse<DraftList>(response);
    setDrafts(body.drafts);
    const nextUnitId = selectUnitId
      ?? body.drafts.at(-1)?.unitId
      ?? null;
    setUnitId(nextUnitId);
    const nextLatest = nextUnitId
      ? body.drafts.filter((draft) => draft.unitId === nextUnitId).at(-1) ?? null
      : null;
    resetDraftForm(nextLatest, admittedLocators);
  }

  async function loadSources(
    targetProjectId: string,
    targetRequestId: string,
    preserveSelection = true,
  ) {
    const response = await fetch(
      `/api/provider/sources?projectId=${encodeURIComponent(targetProjectId)}&requestId=${encodeURIComponent(targetRequestId)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
    const body = await jsonResponse<SourceList>(response);
    setSources(body.sources);
    setSourceLimits(body.limits);
    const admitted = new Set(body.sources.map((source) => source.locator));
    setSelectedSourceLocators((current) =>
      preserveSelection
        ? current.filter((locator) => admitted.has(locator))
        : []);
    return body.sources;
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const projectResponse = await fetch("/api/provider/authoring/projects", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const projectBody = await jsonResponse<ProjectList>(projectResponse);
      if (!active) return;
      setProjects(projectBody.projects);
      if (
        !initialSelection
        || !projectBody.projects.some(
          (item) => item.projectId === initialSelection.projectId,
        )
      ) {
        return;
      }
      setProjectId(initialSelection.projectId);
      const requestResponse = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(initialSelection.projectId)}/requests`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      const requestBody = await jsonResponse<RequestList>(requestResponse);
      if (!active) return;
      setRequests(requestBody.requests);
      if (!requestBody.requests.some(
        (item) => item.requestId === initialSelection.requestId,
      )) {
        return;
      }
      setRequestId(initialSelection.requestId);
      const [sourceResponse, draftResponse] = await Promise.all([
        fetch(
          `/api/provider/sources?projectId=${encodeURIComponent(initialSelection.projectId)}&requestId=${encodeURIComponent(initialSelection.requestId)}`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        ),
        fetch(
          `/api/provider/authoring/projects/${encodeURIComponent(initialSelection.projectId)}/requests/${encodeURIComponent(initialSelection.requestId)}/drafts`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        ),
      ]);
      const [sourceBody, draftBody] = await Promise.all([
        jsonResponse<SourceList>(sourceResponse),
        jsonResponse<DraftList>(draftResponse),
      ]);
      if (!active) return;
      setSources(sourceBody.sources);
      setSourceLimits(sourceBody.limits);
      setDrafts(draftBody.drafts);
      const selectedUnit = draftBody.drafts.some(
        (draft) => draft.unitId === initialSelection.unitId,
      )
        ? initialSelection.unitId
        : draftBody.drafts.at(-1)?.unitId ?? null;
      setUnitId(selectedUnit);
      const selectedDraft = selectedUnit
        ? draftBody.drafts.filter(
          (draft) => draft.unitId === selectedUnit,
        ).at(-1) ?? null
        : null;
      setTitle(selectedDraft?.title ?? "");
      setSummary(selectedDraft?.summary ?? "");
      setScopeText(selectedDraft?.scope.join("\n") ?? "");
      setExclusionsText(selectedDraft?.exclusions.join("\n") ?? "");
      setReviewReady(false);
      const admitted = new Set(
        sourceBody.sources.map((source) => source.locator),
      );
      setSelectedSourceLocators(
        selectedDraft?.sourceReferences
          .map((source) => source.locator)
          .filter((locator) => admitted.has(locator))
        ?? [],
      );
    })()
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error
            ? loadError.message
            : "Provider projects could not be read.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialSelection]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/provider/authoring/projects", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: projectName.trim() }),
      });
      const body = await jsonResponse<ProjectCreated>(response);
      setProjectName("");
      setRequestId(null);
      setRequests([]);
      setDrafts([]);
      setSources([]);
      setSourceLimits(null);
      setSelectedSourceLocators([]);
      setUnitId(null);
      resetDraftForm(null);
      await loadProjects(body.project.projectId);
      await loadRequests(body.project.projectId);
      setMessage("Project created with a server-generated identity.");
    } catch (creationError) {
      setError(creationError instanceof Error
        ? creationError.message
        : "Project could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function selectProject(targetProjectId: string) {
    setProjectId(targetProjectId);
    setRequestId(null);
    setRequests([]);
    setDrafts([]);
    setSources([]);
    setSourceLimits(null);
    setSelectedSourceLocators([]);
    setUnitId(null);
    resetDraftForm(null);
    setBusy(true);
    setError(null);
    try {
      await loadRequests(targetProjectId);
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : "Project requests could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function createRequest(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: requestTitle.trim() }),
        },
      );
      const body = await jsonResponse<RequestCreated>(response);
      setRequestTitle("");
      setDrafts([]);
      setSources([]);
      setSourceLimits(null);
      setSelectedSourceLocators([]);
      setUnitId(null);
      resetDraftForm(null);
      await loadRequests(projectId, body.request.requestId);
      const admitted = await loadSources(
        projectId,
        body.request.requestId,
        false,
      );
      await loadDrafts(
        projectId,
        body.request.requestId,
        undefined,
        new Set(admitted.map((source) => source.locator)),
      );
      setMessage("Request created with a server-generated identity.");
    } catch (creationError) {
      setError(creationError instanceof Error
        ? creationError.message
        : "Request could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function selectRequest(targetRequestId: string) {
    if (!projectId) return;
    setRequestId(targetRequestId);
    setDrafts([]);
    setSources([]);
    setSourceLimits(null);
    setSelectedSourceLocators([]);
    setUnitId(null);
    resetDraftForm(null);
    setBusy(true);
    setError(null);
    try {
      const admitted = await loadSources(projectId, targetRequestId, false);
      await loadDrafts(
        projectId,
        targetRequestId,
        undefined,
        new Set(admitted.map((source) => source.locator)),
      );
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : "Request sources or draft history could not be read.");
    } finally {
      setBusy(false);
    }
  }

  function selectUnit(targetUnitId: string) {
    setUnitId(targetUnitId);
    resetDraftForm(
      drafts.filter((draft) => draft.unitId === targetUnitId).at(-1) ?? null,
      new Set(sources.map((source) => source.locator)),
    );
  }

  async function createDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId || !requestId) return;
    const scope = lines(scopeText);
    const exclusions = lines(exclusionsText);
    if (scope.length === 0) {
      setError("Add at least one included scope item.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const base = `/api/provider/authoring/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}/drafts`;
      const response = await fetch(
        unitId ? `${base}/${encodeURIComponent(unitId)}` : base,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: title.trim(),
            summary: summary.trim(),
            scope,
            exclusions,
            sourceLocators: selectedSourceLocators,
            reviewReady,
          }),
        },
      );
      const body = await jsonResponse<DraftCreated>(response);
      await loadDrafts(
        projectId,
        requestId,
        body.draft.unitId,
        new Set(sources.map((source) => source.locator)),
      );
      setMessage(
        `Immutable draft revision ${body.draft.revision} was recorded as ${
          body.draft.state === "ready-for-client-review"
            ? "ready for commercial preparation"
            : "in progress"
        }.`,
      );
    } catch (creationError) {
      setError(creationError instanceof Error
        ? creationError.message
        : "Draft revision could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !requestId || !sourceFile) return;
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = new FormData();
      data.set("file", sourceFile);
      data.set("projectRequestLocator", `${projectId}/${requestId}`);
      data.set("provenanceOrigin", provenanceOrigin);
      data.set("originReference", originReference);
      data.set(
        "contentAttestation",
        contentAttestation ? "provider-permitted-source" : "",
      );
      data.set("acceptanceBasis", acceptanceBasis);
      data.set("studioSharing", studioSharing);
      data.set("modelProcessing", modelProcessing);
      data.set("modelInputReviewStatus", modelInputReviewStatus);
      data.set("modelReviewBasis", modelReviewBasis);
      const response = await fetch("/api/provider/sources", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        body: data,
      });
      const body = await jsonResponse<SourceUploaded>(response);
      setSourceLimits(body.limits);
      await loadSources(projectId, requestId);
      setSelectedSourceLocators((current) =>
        current.includes(body.source.locator)
          ? current
          : [...current, body.source.locator]);
      form.reset();
      setSourceFile(null);
      setProvenanceOrigin("agreement");
      setOriginReference("");
      setAcceptanceBasis("");
      setContentAttestation(false);
      setStudioSharing("unresolved");
      setModelProcessing("denied");
      setModelInputReviewStatus("not-reviewed");
      setModelReviewBasis("");
      setMessage(
        body.duplicate
          ? "This exact source was already admitted. The existing record is selected."
          : "Source bytes and intake metadata were admitted. The source is selected for the next draft save.",
      );
    } catch (uploadError) {
      setError(uploadError instanceof Error
        ? uploadError.message
        : "Source upload could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function toggleSource(locator: string) {
    setSelectedSourceLocators((current) =>
      current.includes(locator)
        ? current.filter((item) => item !== locator)
        : [...current, locator]);
  }

  return (
    <>
      <div className={styles.workspace}>
        <aside className={styles.register} aria-label="Authoring register">
          <section className={styles.registerSection} aria-labelledby="projects-title">
            <div className={styles.sectionHeading}>
              <h2 id="projects-title">Projects</h2>
              <span className={styles.count}>{projects.length}</span>
            </div>
            <form className={styles.createForm} onSubmit={createProject}>
              <label htmlFor="project-name">New project name</label>
              <input
                className={styles.input}
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                disabled={busy}
                autoComplete="off"
                required
              />
              <div className={styles.fieldMeta}>
                <span>Display name only</span>
                <span>{count(projectName)} / 200</span>
              </div>
              <div className={styles.buttonRow}>
                <button
                  className="button"
                  type="submit"
                  disabled={busy || count(projectName.trim()) < 1 || count(projectName.trim()) > 200}
                >
                  Create project
                </button>
              </div>
            </form>
            {projects.length === 0 ? (
              <p className={styles.empty}>
                No provider-authored projects yet. Create one to begin.
              </p>
            ) : (
              <ul className={styles.registerList}>
                {projects.map((item) => (
                  <li className={styles.registerItem} key={item.projectId}>
                    <button
                      className={styles.registerButton}
                      type="button"
                      aria-current={item.projectId === projectId}
                      disabled={busy}
                      onClick={() => void selectProject(item.projectId)}
                    >
                      <span>{item.displayName}</span>
                      <small>Created {timestamp(item.createdAt)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.registerSection} aria-labelledby="requests-title">
            <div className={styles.sectionHeading}>
              <h2 id="requests-title">Requests</h2>
              <span className={styles.count}>{requests.length}</span>
            </div>
            {projectId ? (
              <>
                <form className={styles.createForm} onSubmit={createRequest}>
                  <label htmlFor="request-title">New request title</label>
                  <input
                    className={styles.input}
                    id="request-title"
                    value={requestTitle}
                    onChange={(event) => setRequestTitle(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    required
                  />
                  <div className={styles.fieldMeta}>
                    <span>Within {project?.displayName}</span>
                    <span>{count(requestTitle)} / 200</span>
                  </div>
                  <div className={styles.buttonRow}>
                    <button
                      className="button"
                      type="submit"
                      disabled={busy || count(requestTitle.trim()) < 1 || count(requestTitle.trim()) > 200}
                    >
                      Create request
                    </button>
                  </div>
                </form>
                {requests.length === 0 ? (
                  <p className={styles.empty}>
                    No requests in this project yet.
                  </p>
                ) : (
                  <ul className={styles.registerList}>
                    {requests.map((item) => (
                      <li className={styles.registerItem} key={item.requestId}>
                        <button
                          className={styles.registerButton}
                          type="button"
                          aria-current={item.requestId === requestId}
                          disabled={busy}
                          onClick={() => void selectRequest(item.requestId)}
                        >
                          <span>{item.title}</span>
                          <small>Created {timestamp(item.createdAt)}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className={styles.empty}>
                Select a project before creating a request.
              </p>
            )}
          </section>
        </aside>

        <section className={styles.workbench} aria-labelledby="workbench-title">
          <div className={styles.workbenchHeading}>
            <div>
              <h2 id="workbench-title">
                {selectedRequest?.title ?? "Draft workbench"}
              </h2>
              <p>
                {selectedRequest
                  ? `${project?.displayName} · immutable revision history`
                  : "Select or create a request to begin an authoring draft."}
              </p>
            </div>
            <span className={styles.draftState}>
              Draft and commercial publication
            </span>
          </div>

          {projectId && project && (
            <ParticipantActivation
              key={projectId}
              projectId={projectId}
              projectLabel={project.displayName}
            />
          )}

          {selectedRequest ? (
            <>
              {unitIds.length > 0 && (
                <section className={styles.unitChooser} aria-labelledby="unit-title">
                  <h3 id="unit-title">Draft threads</h3>
                  <ul className={styles.unitList}>
                    {unitIds.map((item, index) => (
                      <li key={item}>
                        <button
                          className={styles.unitButton}
                          type="button"
                          aria-pressed={item === unitId}
                          onClick={() => selectUnit(item)}
                        >
                          {drafts.find(
                            (draft) =>
                              draft.unitId === item
                              && draft.correctionContexts.length > 0,
                          )
                            ? `Correction reissue · draft ${index + 1}`
                            : `Draft ${index + 1}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {selectedCorrectionContexts.length > 0 && (
                <section
                  className={styles.reissueContext}
                  aria-labelledby="reissue-context-title"
                >
                  <div className={styles.reissueContextHeading}>
                    <div>
                      <span>Material correction reissue</span>
                      <h2 id="reissue-context-title">
                        Carried correction context
                      </h2>
                    </div>
                    <strong>
                      Fresh publication and client decision required
                    </strong>
                  </div>
                  {selectedCorrectionContexts.map((context) => (
                    <article
                      key={`${context.concernId}-${context.assessmentRevision}`}
                      className={styles.reissueContextItem}
                    >
                      <p>
                        <strong>Client correction:</strong> {context.statement}
                      </p>
                      <dl>
                        <div>
                          <dt>Published basis</dt>
                          <dd>Version {context.sourceVersion}</dd>
                        </div>
                        <div>
                          <dt>Claimed source</dt>
                          <dd>
                            {context.claimedSourceType} ·{" "}
                            {context.sourceAvailability}
                          </dd>
                        </div>
                        <div>
                          <dt>Provider source review</dt>
                          <dd>{context.sourceReview}</dd>
                        </div>
                        <div>
                          <dt>Provider assessment</dt>
                          <dd>{context.providerResponse}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                  <p className={styles.reissueBoundary}>
                    Edit by recording the next ordinary immutable draft
                    revision. The correction hold remains active until a newly
                    published version receives a fresh explicit client decision.
                  </p>
                </section>
              )}

              <section className={styles.sources} aria-labelledby="sources-title">
                <div className={styles.sourceHeading}>
                  <div>
                    <h2 id="sources-title">Request sources</h2>
                    <p>
                      Upload and admit a source first, then explicitly select it
                      for a separate immutable draft save.
                    </p>
                  </div>
                  <span className={styles.count}>
                    {selectedSourceLocators.length} selected · {sources.length} admitted
                  </span>
                </div>

                <div className={styles.sourceNotice} id="source-permission-notice">
                  <strong>Synthetic or explicitly permitted material only.</strong>
                  <span>
                    Admission stores private bytes and a bounded provenance record.
                    It does not run a parser or model, create an agreement, publish,
                    or change payment or work readiness.
                  </span>
                  {sourceLimits && (
                    <span role="status">
                      {sourceLimits.blocked
                        ? "Source admission is blocked for the current project window."
                        : `${sourceLimits.remainingCount} source admission${
                          sourceLimits.remainingCount === 1 ? "" : "s"
                        } and ${byteFormatter.format(sourceLimits.remainingBytes)} bytes remain in the ${sourceLimits.windowMinutes}-minute window.`}
                    </span>
                  )}
                </div>

                <div className={styles.sourceGrid}>
                  <form
                    className={styles.sourceForm}
                    onSubmit={uploadSource}
                    aria-describedby="source-permission-notice"
                  >
                    <div className={styles.sourceFormHeading}>
                      <h3>Admit one source</h3>
                      <span>PDF, text, or Markdown · 10 MB maximum</span>
                    </div>

                    <div className={styles.fieldGroup}>
                      <label htmlFor="source-file">Source file</label>
                      <input
                        className={styles.fileInput}
                        id="source-file"
                        type="file"
                        accept="application/pdf,text/plain,text/markdown,.pdf,.txt,.md,.markdown"
                        onChange={(event) =>
                          setSourceFile(
                            event.target.files?.[0]
                              ? sourceFileWithMediaType(event.target.files[0])
                              : null,
                          )}
                        disabled={busy}
                        required
                      />
                    </div>

                    <div className={styles.fieldGrid}>
                      <div className={styles.fieldGroup}>
                        <label htmlFor="provenance-origin">Provenance origin</label>
                        <select
                          className={styles.select}
                          id="provenance-origin"
                          value={provenanceOrigin}
                          onChange={(event) => setProvenanceOrigin(event.target.value)}
                          disabled={busy}
                          required
                        >
                          <option value="agreement">Agreement</option>
                          <option value="amendment">Amendment</option>
                          <option value="correspondence">Correspondence</option>
                          <option value="request">Request</option>
                          <option value="prior-decision">Prior decision</option>
                          <option value="correction">Correction</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className={styles.fieldGroup}>
                        <label htmlFor="origin-reference">
                          Origin reference <span className={styles.optional}>optional</span>
                        </label>
                        <input
                          className={styles.input}
                          id="origin-reference"
                          value={originReference}
                          onChange={(event) => setOriginReference(event.target.value)}
                          disabled={busy}
                          maxLength={2000}
                        />
                      </div>
                    </div>

                    <div className={styles.fieldGroup}>
                      <label htmlFor="acceptance-basis">Import permission basis</label>
                      <textarea
                        className={styles.textarea}
                        id="acceptance-basis"
                        value={acceptanceBasis}
                        onChange={(event) => setAcceptanceBasis(event.target.value)}
                        disabled={busy}
                        maxLength={2000}
                        required
                      />
                      <div className={styles.fieldMeta}>
                        <span>State why the studio may import this source.</span>
                        <span>{count(acceptanceBasis)} / 2,000</span>
                      </div>
                    </div>

                    <div className={styles.permissionGrid}>
                      <div className={styles.fieldGroup}>
                        <label htmlFor="studio-sharing">Studio sharing permission</label>
                        <select
                          className={styles.select}
                          id="studio-sharing"
                          value={studioSharing}
                          onChange={(event) => setStudioSharing(event.target.value)}
                          disabled={busy}
                          required
                        >
                          <option value="permitted">Permitted</option>
                          <option value="denied">Denied</option>
                          <option value="unresolved">Unresolved</option>
                        </select>
                      </div>
                      <div className={styles.fieldGroup}>
                        <label htmlFor="model-processing">Model processing permission</label>
                        <select
                          className={styles.select}
                          id="model-processing"
                          value={modelProcessing}
                          onChange={(event) => setModelProcessing(event.target.value)}
                          disabled={busy}
                          required
                        >
                          <option value="permitted">Permitted</option>
                          <option value="denied">Denied</option>
                          <option value="unresolved">Unresolved</option>
                        </select>
                      </div>
                      <div className={styles.fieldGroup}>
                        <label htmlFor="model-review-status">Model-input review status</label>
                        <select
                          className={styles.select}
                          id="model-review-status"
                          value={modelInputReviewStatus}
                          onChange={(event) =>
                            setModelInputReviewStatus(event.target.value)}
                          aria-invalid={!modelPermissionMatchesReview}
                          disabled={busy}
                          required
                        >
                          <option value="cleared">Cleared</option>
                          <option value="not-reviewed">Not reviewed</option>
                          <option value="unresolved">Unresolved</option>
                          <option value="prohibited-financial-data">
                            Prohibited financial data
                          </option>
                        </select>
                      </div>
                    </div>

                    {!modelPermissionMatchesReview && (
                      <p className={styles.fieldError} role="alert">
                        Model processing may be permitted only when the model-input
                        review status is cleared.
                      </p>
                    )}

                    <div className={styles.fieldGroup}>
                      <label htmlFor="model-review-basis">Model review basis</label>
                      <textarea
                        className={styles.textarea}
                        id="model-review-basis"
                        value={modelReviewBasis}
                        onChange={(event) => setModelReviewBasis(event.target.value)}
                        disabled={busy}
                        maxLength={2000}
                        required
                      />
                      <div className={styles.fieldMeta}>
                        <span>Explain the selected model permission and review status.</span>
                        <span>{count(modelReviewBasis)} / 2,000</span>
                      </div>
                    </div>

                    <label className={styles.attestation} htmlFor="content-attestation">
                      <input
                        id="content-attestation"
                        type="checkbox"
                        checked={contentAttestation}
                        onChange={(event) => setContentAttestation(event.target.checked)}
                        disabled={busy}
                        required
                      />
                      <span>
                        I confirm the provider may import this source for this
                        selected project request.
                      </span>
                    </label>

                    <div className={styles.buttonRow}>
                      <button
                        className="button"
                        type="submit"
                        disabled={
                          busy
                          || !sourceFile
                          || !contentAttestation
                          || count(acceptanceBasis.trim()) < 1
                          || count(acceptanceBasis) > 2_000
                          || count(originReference) > 2_000
                          || count(modelReviewBasis.trim()) < 1
                          || count(modelReviewBasis) > 2_000
                          || !modelPermissionMatchesReview
                          || sourceLimits?.blocked === true
                        }
                      >
                        {busy
                          ? "Admitting source…"
                          : sourceLimits?.blocked
                            ? "Source admission limit reached"
                            : "Upload and admit source"}
                      </button>
                    </div>
                  </form>

                  <div className={styles.sourceRegister} aria-labelledby="admitted-sources-title">
                    <div className={styles.sourceRegisterHeading}>
                      <h3 id="admitted-sources-title">Server-admitted sources</h3>
                      <span>Selection affects only the next draft save.</span>
                    </div>
                    {sources.length === 0 ? (
                      <p className={styles.empty}>
                        No sources are admitted for this exact project request.
                        Drafts may still be saved without sources.
                      </p>
                    ) : (
                      <ul className={styles.sourceList}>
                        {sources.map((source) => (
                          <li className={styles.sourceItem} key={source.locator}>
                            <label>
                              <input
                                type="checkbox"
                                checked={selectedSourceLocators.includes(source.locator)}
                                onChange={() => toggleSource(source.locator)}
                                disabled={busy}
                              />
                              <span className={styles.sourceItemCopy}>
                                <strong>{source.originalName ?? "Unnamed source"}</strong>
                                <span>
                                  {source.displayReference} · {source.provenanceOrigin} ·{" "}
                                  {source.mediaType}
                                </span>
                                <span>
                                  Studio sharing {source.studioSharing}; model processing{" "}
                                  {source.modelProcessing} ({source.modelInputReviewStatus})
                                </span>
                                {source.originReference && (
                                  <span>Origin: {source.originReference}</span>
                                )}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>

              {projectId && requestId && (
                <BaselineConfirmationPanel
                  key={`${projectId}-${requestId}-${sources.map((source) =>
                    source.locator).join("-")}`}
                  projectId={projectId}
                  requestId={requestId}
                  sources={sources}
                />
              )}

              <form className={styles.draftForm} onSubmit={createDraft}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="draft-title">Draft title</label>
                  <input
                    className={styles.input}
                    id="draft-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    disabled={busy}
                    required
                  />
                  <div className={styles.fieldMeta}>
                    <span>{latest ? `Next revision after ${latest.revision}` : "First revision"}</span>
                    <span>{count(title)} / 200</span>
                  </div>
                </div>

                <div className={styles.fieldGroup}>
                  <label htmlFor="draft-summary">Summary</label>
                  <textarea
                    className={`${styles.textarea} ${styles.summaryField}`}
                    id="draft-summary"
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    disabled={busy}
                    required
                  />
                  <div className={styles.fieldMeta}>
                    <span>Explain the exact draft purpose.</span>
                    <span>{count(summary)} / 10,000</span>
                  </div>
                </div>

                <div className={styles.fieldGrid}>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="draft-scope">Included scope</label>
                    <textarea
                      className={styles.textarea}
                      id="draft-scope"
                      value={scopeText}
                      onChange={(event) => setScopeText(event.target.value)}
                      disabled={busy}
                      required
                    />
                    <div className={styles.fieldMeta}>
                      <span>One item per line</span>
                      <span>{lines(scopeText).length} / 100 items</span>
                    </div>
                  </div>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="draft-exclusions">Exclusions</label>
                    <textarea
                      className={styles.textarea}
                      id="draft-exclusions"
                      value={exclusionsText}
                      onChange={(event) => setExclusionsText(event.target.value)}
                      disabled={busy}
                    />
                    <div className={styles.fieldMeta}>
                      <span>Optional · one item per line</span>
                      <span>{lines(exclusionsText).length} / 100 items</span>
                    </div>
                  </div>
                </div>

                <p className={styles.sourceNote}>
                  <strong>Sources are revalidated by the server.</strong>{" "}
                  {selectedSourceLocators.length === 0
                    ? "This revision will be saved without source references."
                    : `${selectedSourceLocators.length} selected source ${
                      selectedSourceLocators.length === 1 ? "locator" : "locators"
                    } will be re-read in this exact project request before immutable references are built.`}
                </p>

                <label className={styles.attestation} htmlFor="review-ready">
                  <input
                    id="review-ready"
                    type="checkbox"
                    checked={reviewReady}
                    onChange={(event) => setReviewReady(event.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    Record this new immutable revision as ready for commercial
                    preparation. Draft content and source references cannot be
                    edited after saving.
                  </span>
                </label>

                <div className={styles.buttonRow}>
                  <button
                    className="button"
                    type="submit"
                    disabled={
                      busy
                      || count(title.trim()) < 1
                      || count(title.trim()) > 200
                      || count(summary.trim()) < 1
                      || count(summary.trim()) > 10_000
                      || lines(scopeText).length < 1
                      || lines(scopeText).length > 100
                      || lines(exclusionsText).length > 100
                    }
                  >
                    {busy
                      ? "Recording revision…"
                      : latest
                        ? "Create next immutable revision"
                        : "Create first immutable revision"}
                  </button>
                </div>
              </form>

              {latest && unitId && projectId && requestId && (
                <CommercialWorkbench
                  key={`${latest.unitId}-${latest.revision}`}
                  projectId={projectId}
                  requestId={requestId}
                  unitId={unitId}
                  draft={latest}
                  unitIds={unitIds}
                />
              )}

              <section className={styles.history} aria-labelledby="history-title">
                <div className={styles.historyHeading}>
                  <h2 id="history-title">Immutable revision history</h2>
                  <span className={styles.count}>
                    {history.length} {history.length === 1 ? "revision" : "revisions"}
                  </span>
                </div>
                {history.length === 0 ? (
                  <p className={styles.empty}>
                    The first saved draft will appear here. Saving does not publish.
                  </p>
                ) : (
                  <ol className={styles.historyList}>
                    {[...history].reverse().map((draft) => (
                      <li className={styles.revision} key={`${draft.unitId}-${draft.revision}`}>
                        <div className={styles.revisionIndex}>
                          Revision {draft.revision}
                          <time className={styles.revisionTime} dateTime={draft.createdAt}>
                            {timestamp(draft.createdAt)}
                          </time>
                        </div>
                        <div>
                          <h3 className={styles.revisionTitle}>{draft.title}</h3>
                          <p className={styles.revisionSummary}>{draft.summary}</p>
                          <div className={styles.revisionColumns}>
                            <div>
                              <h4>Included scope</h4>
                              <ul>
                                {draft.scope.map((item) => <li key={item}>{item}</li>)}
                              </ul>
                            </div>
                            <div>
                              <h4>Exclusions</h4>
                              {draft.exclusions.length ? (
                                <ul>
                                  {draft.exclusions.map((item) => <li key={item}>{item}</li>)}
                                </ul>
                              ) : (
                                <p className={styles.empty}>None recorded.</p>
                              )}
                            </div>
                          </div>
                          <p className={styles.revisionDigest}>
                            Draft reference {draft.draftReference} ·{" "}
                            {draft.sourceReferences.length === 0
                              ? "no source references"
                              : `${draft.sourceReferences.length} server-admitted source references`}{" "}
                            · {draft.state} draft
                          </p>
                          {draft.correctionContexts.length > 0 && (
                            <p className={styles.revisionContext}>
                              Carries {draft.correctionContexts.length} material{" "}
                              {draft.correctionContexts.length === 1
                                ? "correction"
                                : "corrections"} from published version{" "}
                              {draft.correctionContexts
                                .map((context) => context.sourceVersion)
                                .join(", ")}.
                            </p>
                          )}
                          {draft.sourceReferences.length > 0 && (
                            <ul className={styles.revisionSources}>
                              {draft.sourceReferences.map((source) => (
                                <li key={source.locator}>
                                  {source.displayReference}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          ) : (
            <p className={styles.loading}>
              {loading
                ? "Reading protected authoring state…"
                : project
                  ? "Select or create a request after reviewing project participant authority."
                  : "The workbench is ready after a project and request are selected."}
            </p>
          )}
        </section>
      </div>

      <p
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error ?? message ?? (busy ? "Updating protected authoring state…" : "")}
      </p>
    </>
  );
}
