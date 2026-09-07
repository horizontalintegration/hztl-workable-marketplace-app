'use client';

import { useEffect, useState, useCallback } from 'react';
import type { PagesContext } from '@sitecore-marketplace-sdk/client';
import { useMarketplaceClient } from '@/src/utils/hooks/useMarketplaceClient';

/**
 * Per-deployment, not per-code-change: which Sitecore template (as its GraphQL type) and which
 * field on it carries the id this app force-syncs by. Defaults match `hztl-digital-2026`'s
 * `CareerDetailPage`/`careerJobId` (see that repo's `careerSitecoreSyncClient.ts`,
 * `CAREER_PAGE_GRAPHQL_TYPE`), but a project reusing this app only needs to set these two
 * `NEXT_PUBLIC_*` vars at build time - no code change - to point it at a different template.
 * `NEXT_PUBLIC_` is required because this file is a Client Component; Next inlines these at
 * build time, so changing them means redeploying, not just restarting.
 */
const ITEM_GRAPHQL_TYPE = process.env.NEXT_PUBLIC_SITECORE_ITEM_GRAPHQL_TYPE || 'CareerDetailPage';
const ITEM_ID_FIELD = process.env.NEXT_PUBLIC_SITECORE_ITEM_ID_FIELD || 'careerJobId';

/**
 * The inline fragment not matching IS the "this item isn't the configured type" check - it
 * simply won't populate `[ITEM_ID_FIELD]`, so no separate template lookup is needed.
 */
const ITEM_QUERY = `
  query GetForceSyncId($itemId: ID!, $language: String!) {
    item(where: { itemId: $itemId, language: $language }) {
      itemId
      path
      ... on ${ITEM_GRAPHQL_TYPE} {
        ${ITEM_ID_FIELD} { value }
      }
    }
  }
`;

interface ForceSyncItemQueryResult {
  item?: {
    itemId?: string;
    path?: string;
    // The real key is whatever ITEM_ID_FIELD is configured to - not statically known here.
    [fieldName: string]: unknown;
  };
}

/**
 * `client.mutate('xmc.authoring.graphql', ...)`'s resolved type is a conditional type from
 * `@hey-api/client-fetch` (varies by `ThrowOnError`) that TypeScript widens into an awkward
 * union - safer to narrow it at runtime through `unknown` than to fight that union with casts.
 * Returns the query's `data.item`, or `null` if the call failed at either the network or the
 * GraphQL level.
 */
function extractForceSyncItem(result: unknown): ForceSyncItemQueryResult['item'] | null {
  if (!result || typeof result !== 'object') return null;
  const maybeError = (result as { error?: unknown }).error;
  if (maybeError) return null;
  const envelope = (result as { data?: { data?: unknown; errors?: unknown[] } }).data;
  if (!envelope || (envelope.errors && envelope.errors.length > 0) || !envelope.data) {
    return null;
  }
  return (envelope.data as ForceSyncItemQueryResult).item ?? null;
}

function extractSyncId(item: ForceSyncItemQueryResult['item']): string | null {
  const field = item?.[ITEM_ID_FIELD] as { value?: string } | undefined;
  return field?.value ?? null;
}

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'success'; operation: string }
  | { status: 'error'; message: string };

interface SyncLookupResult {
  key: string;
  syncId: string | null;
  error: string | null;
}

function PagesContextPanel() {
  const { client, error: clientError, isInitialized } = useMarketplaceClient();
  const [pagesContext, setPagesContext] = useState<PagesContext>();
  const [syncLookup, setSyncLookup] = useState<SyncLookupResult | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });

  useEffect(() => {
    if (clientError || !isInitialized || !client) {
      return;
    }
    let unsubscribe: (() => void) | undefined;
    client
      .query('pages.context', {
        subscribe: true,
        onSuccess: (res) => setPagesContext(res),
      })
      .then((result) => {
        unsubscribe = result?.unsubscribe;
      })
      .catch((err) => console.error('Error retrieving pages.context:', err));

    return () => {
      unsubscribe?.();
    };
  }, [client, clientError, isInitialized]);

  const itemId = pagesContext?.pageInfo?.id;
  const language = pagesContext?.pageInfo?.language;

  useEffect(() => {
    if (!client || !itemId || !language) {
      return;
    }

    const key = `${itemId}::${language}`;
    let cancelled = false;

    client
      .mutate('xmc.authoring.graphql', {
        params: { body: { query: ITEM_QUERY, variables: { itemId, language } } },
      })
      .then((result) => {
        if (cancelled) return;
        const item = extractForceSyncItem(result);
        if (!item) {
          setSyncLookup({ key, syncId: null, error: 'Could not read this item from Sitecore.' });
          return;
        }
        // `null` here covers both "fragment didn't match" (wrong item type) and "field is
        // genuinely empty" - normalized so it's distinguishable from "still loading" (no
        // result yet for this key).
        setSyncLookup({ key, syncId: extractSyncId(item), error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error fetching the force-sync id:', err);
        setSyncLookup({ key, syncId: null, error: 'Could not read this item from Sitecore.' });
      });

    return () => {
      cancelled = true;
    };
  }, [client, itemId, language]);

  // The lookup result is only "current" once it was recorded for this exact itemId/language -
  // otherwise it's stale (from a previous item) or absent (still loading), so `syncId` reads as
  // `undefined` in both of those cases, same as before this used a ref-free derived value
  // instead of resetting state at the top of the effect above.
  const currentKey = itemId && language ? `${itemId}::${language}` : null;
  const isCurrent = syncLookup?.key === currentKey;
  const syncId = isCurrent ? syncLookup.syncId : undefined;
  const itemLookupError = isCurrent ? syncLookup.error : null;

  const handleForceSync = useCallback(async () => {
    if (!syncId) return;
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetch('/api/force-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcode: syncId }),
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
  }, [syncId, client]);

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

      {!isInitialized || syncId === undefined ? (
        <p>Loading page context...</p>
      ) : syncId === null ? (
        <p>{itemLookupError ?? `This item is not a ${ITEM_GRAPHQL_TYPE}.`}</p>
      ) : (
        <>
          <p>
            Workable job: <strong>{syncId}</strong>
          </p>
          <button onClick={handleForceSync} disabled={syncState.status === 'syncing'}>
            {syncState.status === 'syncing' ? 'Syncing...' : 'Force Sync'}
          </button>
          {syncState.status === 'success' && <p>Synced ({syncState.operation}).</p>}
          {syncState.status === 'error' && <p role="alert">Sync failed: {syncState.message}</p>}
        </>
      )}
    </div>
  );
}

export default PagesContextPanel;
