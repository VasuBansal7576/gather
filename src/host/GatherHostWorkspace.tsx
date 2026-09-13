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

/**
 * Host adapter for the local Gather workspace service. Loads persisted
 * workspace data over HTTP, keeps selection across refreshes, and routes the
 * UI's exact-identity approval / retry / reconcile callbacks to the real
 * endpoints. Mutations re-fetch the workspace so receipts always reflect the
 * durable server record; failures surface as an honest banner, never as
 * silent success.
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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setWorkspace(await fetchWorkspace());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = useCallback(async (identity: ProposalIdentity): Promise<void> => {
    const key = `approve:${identity.proposalFingerprint}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      await approveProposal(identity);
      await refresh();
    } catch (error) {
      // The proposal panel shows its own send-failed state; the banner adds
      // the server's exact reason (stale version, slot taken, revoked access).
      setNotice(noticeFor(error, 'Approval failed'));
      throw error;
    } finally {
      inFlight.current.delete(key);
    }
  }, [refresh]);

  const retry = useCallback((request: ActionRetryRequest): void => {
    const key = `retry:${request.actionId}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    retryAction(request.actionId)
      .then(() => refresh())
      .catch((error) => setNotice(noticeFor(error, 'Retry failed')))
      .finally(() => inFlight.current.delete(key));
  }, [refresh]);

  const reconcile = useCallback((request: ExecutionReconcileRequest): void => {
    const key = `reconcile:${request.executionId}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    reconcileExecution(request.executionId)
      .then(() => refresh())
      .catch((error) => setNotice(noticeFor(error, 'Reconciliation failed')))
      .finally(() => inFlight.current.delete(key));
  }, [refresh]);

  const seedDemo = useCallback((): void => {
    if (seeding) return;
    setSeeding(true);
    initDemoFixtures()
      .then(() => refresh())
      .catch((error) => setNotice(noticeFor(error, 'Demo seeding failed')))
      .finally(() => setSeeding(false));
  }, [refresh, seeding]);

  const adapted = workspace === undefined ? undefined : adaptWorkspace(workspace);
  const empty = adapted !== undefined && adapted.bookings.length === 0;

  if (loadError !== undefined && adapted === undefined) {
    return (
      <div className="gather-app-shell" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <section role="alert" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ margin: '0 0 8px' }}>The workspace did not load</h1>
          <p style={{ margin: '0 0 16px', color: '#7d7167' }}>{loadError}</p>
          <button type="button" className="gather-primary-button gather-small-button" onClick={() => { setLoading(true); void refresh(); }}>
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
          aria-label="Empty demo workspace"
          style={{
            position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center',
            background: 'rgba(250, 247, 242, 0.92)',
          }}
        >
          <div style={{ maxWidth: 420, textAlign: 'center', background: '#fff', border: '1px solid #e8e1d5', borderRadius: 16, padding: '28px 24px' }}>
            <span className="gather-demo-label">Demo data</span>
            <h2 style={{ margin: '10px 0 6px' }}>The demo workspace is empty</h2>
            <p style={{ margin: '0 0 18px', color: '#7d7167', fontSize: 13 }}>
              Seed explicitly fictional bookings, proposals, and connected accounts into the local store — nothing real is touched.
            </p>
            <button type="button" className="gather-primary-button gather-small-button" disabled={seeding} onClick={seedDemo}>
              {seeding ? 'Loading fixtures…' : 'Load demo fixtures'}
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
