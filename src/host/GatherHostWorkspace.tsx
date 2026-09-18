'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GatherWorkspace } from '../components/gather';
import type { ActionRetryRequest, ExecutionReconcileRequest, ProposalIdentity } from '../components/gather/types.ts';
import { VoiceIntakePanel, type VoiceTranscriptView } from '../components/gather/voice/index.ts';
import { ASSEMBLYAI_MAX_AUDIO_BYTES } from '../integrations/assemblyai/config.ts';
import type { VoiceClarification } from '../integrations/assemblyai/intake.ts';
import type { IntegrationProfileId } from '../integrations/contracts.ts';
import { adaptWorkspace } from './adapter.ts';
import { ApiError, approveProposal, fetchWorkspace, initDemoFixtures, reconcileExecution, retryAction } from './api.ts';
import type { WorkspaceDTO } from './dto.ts';

interface HostNotice {
  title: string;
  description: string;
  actionLabel?: string;
}

function noticeFor(error: unknown, fallback: string): HostNotice {
  if (error instanceof ApiError) {
    return {
      title: 'The workspace service could not complete that',
      description: `${error.message}${error.retryable ? ' You can try again.' : ''}`,
      actionLabel: 'Dismiss',
    };
  }
  return { title: 'Something went wrong', description: error instanceof Error ? error.message : fallback, actionLabel: 'Dismiss' };
}

const STALE_NOTICE: HostNotice = {
  title: 'Could not refresh the workspace',
  description: 'The latest data did not load — what you see may be out of date. Try again before acting on it.',
  actionLabel: 'Dismiss',
};

/** ADR-016 selected submission profile (mirrors GATHER_INTEGRATION_PROFILE; default base). */
const SELECTED_PROFILE_KEY = 'gather:integration-profile';

function readSelectedProfile(): IntegrationProfileId {
  try {
    const raw = window.localStorage.getItem(SELECTED_PROFILE_KEY);
    if (raw === 'assemblyai' || raw === 'amazon' || raw === 'nebius') return raw;
  } catch {
    // Private-mode storage never blocks the workspace.
  }
  return 'base';
}

function useSelectedProfile(): IntegrationProfileId {
  const [selected, setSelected] = useState<IntegrationProfileId>('base');
  useEffect(() => {
    setSelected(readSelectedProfile());
    const onChange = (): void => setSelected(readSelectedProfile());
    window.addEventListener('gather:profile-change', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('gather:profile-change', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return selected;
}

const mountCard: React.CSSProperties = {
  border: '1px solid #232329',
  borderRadius: 12,
  padding: '16px 18px',
  margin: '12px auto',
  maxWidth: 880,
  background: '#111114',
  color: '#ececf0',
};

/**
 * ADR-016 voice mount: renders the ADR-013 VoiceIntakePanel only when the
 * assemblyai profile is selected, wired to the real status/transcribe
 * routes. Any other selection unmounts it — the adapter receives no audio.
 */
function VoiceProfileMount() {
  const [enabled, setEnabled] = useState(false);
  const [disabledReason, setDisabledReason] = useState<string | undefined>(undefined);
  const [maxAudioBytes, setMaxAudioBytes] = useState(ASSEMBLYAI_MAX_AUDIO_BYTES);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [transcript, setTranscript] = useState<VoiceTranscriptView | undefined>();
  const [clarification, setClarification] = useState<VoiceClarification | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/status', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json().catch(() => undefined)) as
          | { enabled?: boolean; missingEvidence?: string; limits?: { maxAudioBytes?: number } }
          | undefined;
        if (!body) return;
        setEnabled(body.enabled === true);
        setDisabledReason(typeof body.missingEvidence === 'string' ? body.missingEvidence : undefined);
        if (typeof body.limits?.maxAudioBytes === 'number') setMaxAudioBytes(body.limits.maxAudioBytes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const onSelectFile = useCallback(async (file: File): Promise<void> => {
    setUploading(true);
    setError(undefined);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the selected audio file.'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const audioBase64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ audioBase64, contentType: file.type || 'audio/wav' }),
      });
      const body = (await response.json().catch(() => undefined)) as
        | { transcript?: { text?: string; confidence?: number | null; simulated?: boolean; provenance?: string }; clarification?: VoiceClarification; error?: { message?: string } }
        | undefined;
      if (!response.ok) throw new Error(body?.error?.message ?? 'Transcription failed.');
      if (!body?.transcript || typeof body.transcript.text !== 'string') throw new Error('Transcription returned no text.');
      setTranscript({
        text: body.transcript.text,
        confidence: body.transcript.confidence ?? null,
        simulated: body.transcript.simulated === true,
        provenance: body.transcript.provenance ?? 'voice:assemblyai',
      });
      setClarification(body.clarification);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Transcription failed.');
    } finally {
      setUploading(false);
    }
  }, []);

  return (
    <div style={{ maxWidth: 912, margin: '0 auto', padding: '0 16px' }}>
      {error ? <p role="alert" style={{ color: '#f2b8b5' }}>{error}</p> : null}
      <VoiceIntakePanel
        transcript={transcript}
        clarification={clarification}
        disabled={!enabled}
        disabledReason={disabledReason}
        uploading={uploading}
        onSelectFile={(file) => void onSelectFile(file)}
        maxAudioBytes={maxAudioBytes}
      />
    </div>
  );
}

/**
 * ADR-016 non-voice event mount: owner-visible capability gate for the
 * amazon / nebius profiles, read live from /api/live-model/status. States
 * the exact missing evidence; never claims a live proof.
 */
function EventGateMount({ profile }: { profile: 'amazon' | 'nebius' }) {
  const [gate, setGate] = useState<{ liveReady: boolean; blockedBy: string[] } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/live-model/status?profile=${profile}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json().catch(() => undefined)) as
          | { gate?: { liveReady?: boolean; blockedBy?: string[] } }
          | undefined;
        if (body?.gate) {
          setGate({
            liveReady: body.gate.liveReady === true,
            blockedBy: Array.isArray(body.gate.blockedBy) ? body.gate.blockedBy.map(String) : [],
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile]);
  const title = profile === 'amazon' ? 'Amazon owner interface' : 'Nebius/NVIDIA model';
  return (
    <div style={{ maxWidth: 912, margin: '0 auto', padding: '0 16px' }}>
      <section aria-label={`${title} profile status`} style={mountCard}>
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{title} — selected profile</h2>
        {gate === undefined ? (
          <p style={{ margin: 0, color: '#8a8a95', fontSize: 13 }}>Checking capability gates…</p>
        ) : gate.liveReady ? (
          <p role="status" style={{ margin: 0, fontSize: 13 }}>
            Capability gates pass on explicitly authorized accounts. Live sends stay restricted to the configured test recipient.
          </p>
        ) : (
          <div role="status">
            <p style={{ margin: '0 0 6px', fontSize: 13 }}><strong>Live verification is blocked — missing:</strong></p>
            <ul style={{ margin: '0 0 6px', paddingLeft: 18, fontSize: 13, color: '#c9c9d2' }}>
              {gate.blockedBy.map((missing) => <li key={missing}>{missing}</li>)}
            </ul>
            <p style={{ margin: 0, color: '#8a8a95', fontSize: 13 }}>Prepared mode stays fully usable. No fixture evidence counts as live proof.</p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Host adapter for the local Gather workspace service. Loads persisted
 * workspace data over HTTP, keeps selection across refreshes, and routes the
 * UI's exact-identity approval / retry / reconcile callbacks to the real
 * endpoints. Mutations re-fetch the workspace on success AND failure so
 * receipts always reflect the durable record — a failed mutation still
 * re-reads the server while the original error stays visible. A generation
 * counter drops out-of-order refresh responses so a slow earlier fetch can
 * never overwrite a newer one.
 */
export function GatherHostWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceDTO | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [notice, setNotice] = useState<HostNotice | undefined>();
  // In-flight mutation keys — every mutation path dedupes so a second click
  // (or a double event) can never issue a duplicate write.
  const inFlight = useRef(new Set<string>());
  // Monotonic refresh generation — an out-of-order response can never win.
  const refreshGen = useRef(0);

  const refresh = useCallback(async (): Promise<boolean> => {
    const generation = ++refreshGen.current;
    try {
      const fresh = await fetchWorkspace();
      if (generation === refreshGen.current) {
        setWorkspace(fresh);
        setLoadError(undefined);
      }
      return true;
    } catch (error) {
      if (generation === refreshGen.current) {
        setLoadError(error instanceof Error ? error.message : 'Could not load the workspace');
      }
      return false;
    } finally {
      if (generation === refreshGen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every mutation is followed by a refresh attempt — success OR failure —
  // so receipts reflect the durable record either way. A refresh failure
  // while data is loaded keeps the workspace but discloses staleness; the
  // original mutation error is preserved, never swallowed by the refresh.
  const settle = useCallback(async (mutationError: unknown, fallback: string): Promise<void> => {
    const refreshed = await refresh();
    if (!refreshed) {
      setNotice(mutationError !== undefined ? noticeFor(mutationError, fallback) : STALE_NOTICE);
      return;
    }
    if (mutationError !== undefined) setNotice(noticeFor(mutationError, fallback));
  }, [refresh]);

  const approve = useCallback(async (identity: ProposalIdentity): Promise<void> => {
    const key = `approve:${identity.proposalFingerprint}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    let mutationError: unknown;
    try {
      await approveProposal(identity);
    } catch (error) {
      mutationError = error;
    }
    try {
      await settle(mutationError, 'Approval failed');
    } finally {
      inFlight.current.delete(key);
    }
    // Re-throw the original error so the proposal panel shows send-failed.
    if (mutationError !== undefined) throw mutationError;
  }, [settle]);

  const retry = useCallback((request: ActionRetryRequest): void => {
    const key = `retry:${request.actionId}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    retryAction(request.actionId)
      .then(
        () => settle(undefined, 'Retry failed'),
        (error: unknown) => settle(error, 'Retry failed'),
      )
      .finally(() => inFlight.current.delete(key));
  }, [settle]);

  const reconcile = useCallback((request: ExecutionReconcileRequest): void => {
    const key = `reconcile:${request.executionId}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    reconcileExecution(request.executionId)
      .then(
        () => settle(undefined, 'Reconciliation failed'),
        (error: unknown) => settle(error, 'Reconciliation failed'),
      )
      .finally(() => inFlight.current.delete(key));
  }, [settle]);

  const seedDemo = useCallback((): void => {
    if (seeding) return;
    setSeeding(true);
    initDemoFixtures()
      .then(
        () => settle(undefined, 'Could not load the demo bookings'),
        (error: unknown) => settle(error, 'Could not load the demo bookings'),
      )
      .finally(() => setSeeding(false));
  }, [settle, seeding]);

  const adapted = workspace === undefined ? undefined : adaptWorkspace(workspace);
  const empty = adapted !== undefined && adapted.bookings.length === 0;
  // ADR-016 profile mounts: exactly one event mount renders, only when its
  // profile is selected. Anything unselected stays unmounted and receives
  // no data (verified in tests/release-profile-routing.test.ts).
  const selectedProfile = useSelectedProfile();

  if (loadError !== undefined && adapted === undefined) {
    return (
      <div className="gather-app-shell" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <section role="alert" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 16 }}>The workspace did not load</h1>
          <p style={{ margin: '0 0 16px', color: '#8a8a95', fontSize: 13 }}>{loadError}</p>
          <button type="button" className="gather-secondary-button gather-small-button" onClick={() => { setLoading(true); void refresh(); }}>
            Try again
          </button>
        </section>
      </div>
    );
  }

  return (
    <>
      {empty ? (
        <section
          aria-label="Empty workspace"
          style={{
            position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center',
            background: 'rgba(11, 11, 14, 0.94)',
          }}
        >
          <div style={{ maxWidth: 420, textAlign: 'center', background: '#111114', border: '1px solid #232329', borderRadius: 16, padding: '28px 24px', color: '#ececf0' }}>
            {/* The label follows the server's evidence marker — an empty
                connected workspace is unverified, never "Demo data". */}
            {adapted?.dataMode === 'demo' ? <span className="gather-demo-label">Demo data</span> : null}
            {adapted?.dataMode === 'unknown' ? <span className="gather-demo-label"><span className="gather-unverified-dot" />Unverified data</span> : null}
            <h2 style={{ margin: '10px 0 6px', fontSize: 15 }}>There are no bookings to review yet</h2>
            <p style={{ margin: '0 0 18px', color: '#8a8a95', fontSize: 13 }}>
              {adapted?.dataMode === 'demo'
                ? 'Load a set of fictional demo bookings so you can try the review and approval flow — nothing real is touched.'
                : 'Your apps are connected. There are no bookings to review yet. You can load fictional demo bookings to try the review and approval flow.'}
            </p>
            <button type="button" className="gather-approve-button" disabled={seeding} onClick={seedDemo}>
              {seeding ? 'Loading demo bookings…' : 'Load demo bookings'}
            </button>
          </div>
        </section>
      ) : null}
      {selectedProfile === 'assemblyai' ? <VoiceProfileMount /> : null}
      {selectedProfile === 'amazon' ? <EventGateMount profile="amazon" /> : null}
      {selectedProfile === 'nebius' ? <EventGateMount profile="nebius" /> : null}
      <GatherWorkspace
        bookings={adapted?.bookings ?? []}
        connections={adapted?.connections ?? []}
        loading={loading}
        blockedState={notice}
        dataMode={adapted?.dataMode ?? 'demo'}
        businessId={adapted?.businesses[0]?.id}
        pendingApprovals={adapted?.pendingApprovals ?? []}
        onApproveProposal={approve}
        onRetryAction={retry}
        onReconcileExecution={reconcile}
        onRetryBlockedAction={() => setNotice(undefined)}
      />
    </>
  );
}
