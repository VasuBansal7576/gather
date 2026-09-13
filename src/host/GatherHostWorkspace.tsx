'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GatherWorkspace } from '../components/gather';
import type { ActionRetryRequest, ExecutionReconcileRequest, ProposalIdentity } from '../components/gather/types.ts';
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
                : 'Nothing has arrived from your connected sources yet — new inquiries appear here automatically. You can also load fictional demo bookings to try the review and approval flow.'}
            </p>
            <button type="button" className="gather-approve-button" disabled={seeding} onClick={seedDemo}>
              {seeding ? 'Loading demo bookings…' : 'Load demo bookings'}
            </button>
          </div>
        </section>
      ) : null}
      <GatherWorkspace
        bookings={adapted?.bookings ?? []}
        connections={adapted?.connections ?? []}
        loading={loading}
        blockedState={notice}
        dataMode={adapted?.dataMode ?? 'demo'}
        pendingApprovals={adapted?.pendingApprovals ?? []}
        onApproveProposal={approve}
        onRetryAction={retry}
        onReconcileExecution={reconcile}
        onRetryBlockedAction={() => setNotice(undefined)}
      />
    </>
  );
}
