'use client';

import { useEffect, useState, useCallback } from 'react';
import type { PagesContext } from '@sitecore-marketplace-sdk/client';
import { useMarketplaceClient } from '@/src/utils/hooks/useMarketplaceClient';

/**
 * `CareerDetailPage`'s GraphQL type and `careerJobId` field name, mirrored from
 * `hztl-digital-2026`'s `headapps/hztl/src/lib/workable/careerSitecoreSyncClient.ts`
 * (`CAREER_PAGE_GRAPHQL_TYPE`). The inline fragment is also how we detect "this item
 * isn't a Career Detail Page" - it simply won't populate `careerJobId`, no separate
 * template check needed.
 */
const ITEM_QUERY = `
  query GetCareerJobId($itemId: ID!, $language: String!) {
    item(where: { itemId: $itemId, language: $language }) {
      itemId
      path
      ... on CareerDetailPage {
        careerJobId { value }
      }
    }
  }
`;

interface CareerJobItemQueryResult {
  item?: {
    itemId?: string;
    path?: string;
    careerJobId?: { value?: string };
  };
}

/**
 * `client.mutate('xmc.authoring.graphql', ...)`'s resolved type is a conditional type from
 * `@hey-api/client-fetch` (varies by `ThrowOnError`) that TypeScript widens into an awkward
 * union - safer to narrow it at runtime through `unknown` than to fight that union with casts.
 * Returns the query's `data.item`, or `null` if the call failed at either the network or the
 * GraphQL level.
 */
function extractCareerJobItem(result: unknown): CareerJobItemQueryResult['item'] | null {
  if (!result || typeof result !== 'object') return null;
  const maybeError = (result as { error?: unknown }).error;
  if (maybeError) return null;
  const envelope = (result as { data?: { data?: unknown; errors?: unknown[] } }).data;
  if (!envelope || (envelope.errors && envelope.errors.length > 0) || !envelope.data) {
    return null;
  }
  return (envelope.data as CareerJobItemQueryResult).item ?? null;
}

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'success'; operation: string }
  | { status: 'error'; message: string };

function PagesContextPanel() {
  const { client, error: clientError, isInitialized } = useMarketplaceClient();
  const [pagesContext, setPagesContext] = useState<PagesContext>();
  const [careerJobId, setCareerJobId] = useState<string | null | undefined>(undefined);
  const [itemLookupError, setItemLookupError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });

  useEffect(() => {
    if (clientError || !isInitialized || !client) {
      return;
    }
    client
      .query('pages.context', {
        subscribe: true,
        onSuccess: (res) => setPagesContext(res),
      })
      .catch((err) => console.error('Error retrieving pages.context:', err));
  }, [client, clientError, isInitialized]);

  const itemId = pagesContext?.pageInfo?.id;
  const language = pagesContext?.pageInfo?.language;

  useEffect(() => {
    if (!client || !itemId || !language) {
      return;
    }

    let cancelled = false;
    setCareerJobId(undefined);
    setItemLookupError(null);

    client
      .mutate('xmc.authoring.graphql', {
        params: { body: { query: ITEM_QUERY, variables: { itemId, language } } },
      })
      .then((result) => {
        if (cancelled) return;
        const item = extractCareerJobItem(result);
        if (!item) {
          setItemLookupError('Could not read this item from Sitecore.');
          setCareerJobId(null);
          return;
        }
        // `undefined` (fragment didn't match) means "not a Career Detail Page" -
        // normalize to `null` so it's distinguishable from "still loading".
        setCareerJobId(item.careerJobId?.value ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error fetching careerJobId:', err);
        setItemLookupError('Could not read this item from Sitecore.');
        setCareerJobId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [client, itemId, language]);

  const handleForceSync = useCallback(async () => {
    if (!careerJobId) return;
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetch('/api/force-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcode: careerJobId }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setSyncState({ status: 'error', message: body.error ?? `Request failed (${res.status})` });
        return;
      }
      setSyncState({ status: 'success', operation: body.operation });
      // Best-effort refresh of the editor canvas so the just-synced content shows up
      // without the editor manually reloading. Never let this fail the sync itself.
      client?.mutate('pages.reloadCanvas').catch((err) => {
        console.error('pages.reloadCanvas failed after a successful sync:', err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSyncState({ status: 'error', message });
    }
  }, [careerJobId, client]);

  return (
    <div
      style={{
        padding: '1rem',
        border: '1px solid #ccc',
        borderRadius: '8px',
        maxWidth: '600px',
        margin: '2rem auto',
      }}
    >
      <h3>Workable force sync</h3>

      {!isInitialized || careerJobId === undefined ? (
        <p>Loading page context...</p>
      ) : careerJobId === null ? (
        <p>{itemLookupError ?? 'This item is not a Career Detail Page.'}</p>
      ) : (
        <>
          <p>
            Workable job: <strong>{careerJobId}</strong>
          </p>
          <button onClick={handleForceSync} disabled={syncState.status === 'syncing'}>
            {syncState.status === 'syncing' ? 'Syncing...' : 'Force sync from Workable'}
          </button>
          {syncState.status === 'success' && <p>Synced ({syncState.operation}).</p>}
          {syncState.status === 'error' && <p role="alert">Sync failed: {syncState.message}</p>}
        </>
      )}
    </div>
  );
}

export default PagesContextPanel;
