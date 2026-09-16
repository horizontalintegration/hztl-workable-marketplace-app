'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentProps } from 'react';
import type { PagesContext } from '@sitecore-marketplace-sdk/client';
import { useMarketplaceClient } from '@/src/utils/hooks/useMarketplaceClient';
import { Alert, AlertDescription } from '@/src/components/ui/alert';
import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@/src/components/ui/card';
import { Skeleton } from '@/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';

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

/** Field on the same template holding the human-readable job title, shown alongside the job id. */
const ITEM_TITLE_FIELD = process.env.NEXT_PUBLIC_SITECORE_ITEM_TITLE_FIELD || 'careerTitle';

/**
 * Path to the Site Settings item, and the Droplink/Droptree field on it, that name the "Careers
 * root" page - the one page the Bulk Import button shows on. Defaults match
 * `hztl-digital-2026`'s `SITE_SETTINGS_ITEM_PATH`/`careersRootPage` (see that repo's
 * `careerSitecoreSyncClient.ts`). Same reuse/override story as `ITEM_GRAPHQL_TYPE` above.
 */
const CAREERS_ROOT_SETTINGS_PATH =
  process.env.NEXT_PUBLIC_SITECORE_CAREERS_ROOT_SETTINGS_PATH ||
  '/sitecore/content/HztlFoundation/HztlDigital/Settings/Site Settings';
const CAREERS_ROOT_FIELD = process.env.NEXT_PUBLIC_SITECORE_CAREERS_ROOT_FIELD || 'careersRootPage';

/**
 * Uses Sitecore's generic `field(name:)` accessor rather than a typed inline fragment, so
 * this doesn't depend on `ITEM_GRAPHQL_TYPE` being registered as a distinct object type in
 * the Authoring GraphQL schema - only on the field existing on the item. Same pattern this
 * project's Workable import already relies on (see `careerSitecoreSyncClient.ts`'s
 * `field(name: "careerJobId")`). An item whose template lacks this field still returns
 * `null` for it, which remains the "this item isn't the configured type" signal - no
 * separate template lookup is needed.
 */
const ITEM_QUERY = `
  query GetForceSyncId($itemId: ID!, $language: String!) {
    item(where: { itemId: $itemId, language: $language }) {
      itemId
      path
      ${ITEM_ID_FIELD}: field(name: "${ITEM_ID_FIELD}") {
        value
      }
      ${ITEM_TITLE_FIELD}: field(name: "${ITEM_TITLE_FIELD}") {
        value
      }
    }
  }
`;

/**
 * Same generic-field reasoning as `ITEM_QUERY` above - a Droplink field's raw value is the
 * target item's id. Uses the `where:` wrapper, not a bare `path` argument - Authoring's
 * `item` root field takes `where: { path, language }`, unlike Edge's `item(path:, language:)`
 * shape (see `careerSitecoreSyncClient.ts`'s `resolveCareersRootPath`, which targets Edge).
 */
const CAREERS_ROOT_QUERY = `
  query GetCareersRootId($path: String!, $language: String!) {
    item(where: { path: $path, language: $language }) {
      ${CAREERS_ROOT_FIELD}: field(name: "${CAREERS_ROOT_FIELD}") {
        value
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
 * Every xmc.authoring.graphql call must be scoped with the app's Sitecore Context ID, or the
 * host's edge GraphQL endpoint has nothing to route the request to and 404s (see
 * doc.sitecore.com/mp/.../make-a-graphql-query.html) - it comes from `application.context`, not
 * `pages.context`, so it's fetched once via a separate query.
 */
interface ApplicationContextResult {
  resourceAccess?: Array<{ context?: { live?: string } }>;
}

function extractSitecoreContextId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const data = (result as { data?: ApplicationContextResult }).data;
  return data?.resourceAccess?.[0]?.context?.live;
}

/**
 * `client.mutate('xmc.authoring.graphql', ...)`'s resolved type is a conditional type from
 * `@hey-api/client-fetch` (varies by `ThrowOnError`) that TypeScript widens into an awkward
 * union - safer to narrow it at runtime through `unknown` than to fight that union with casts.
 * Returns the query's `data.item`, or `null` if the call failed at either the network or the
 * GraphQL level. Shared by both `xmc.authoring.graphql` queries this panel makes.
 */
function unwrapGraphQLItem(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const maybeError = (result as { error?: unknown }).error;
  if (maybeError) return null;
  const envelope = (result as { data?: { data?: unknown; errors?: unknown[] } }).data;
  if (!envelope || (envelope.errors && envelope.errors.length > 0) || !envelope.data) {
    return null;
  }
  const item = (envelope.data as { item?: unknown }).item;
  return (item as Record<string, unknown>) ?? null;
}

function extractSyncId(item: Record<string, unknown> | null): string | null {
  const field = item?.[ITEM_ID_FIELD] as { value?: string } | undefined;
  return field?.value ?? null;
}

function extractTitle(item: Record<string, unknown> | null): string | null {
  const field = item?.[ITEM_TITLE_FIELD] as { value?: string } | undefined;
  return field?.value ?? null;
}

function extractCareersRootId(item: Record<string, unknown> | null): string | null {
  const field = item?.[CAREERS_ROOT_FIELD] as { value?: string } | undefined;
  return field?.value || null;
}

/** Sitecore item ids compare equal regardless of brace/casing - normalize before comparing. */
function normalizeItemId(id: string): string {
  return id.replace(/[{}]/g, '').toLowerCase();
}

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'success'; operation: string }
  | { status: 'error'; message: string };

interface SyncLookupResult {
  key: string;
  syncId: string | null;
  title: string | null;
  error: string | null;
}

type JobResultStatus = 'created' | 'updated' | 'skipped' | 'failed' | 'deleted';

interface JobResult {
  jobId: string;
  title: string;
  sitecoreItemId?: string | null;
  status: JobResultStatus;
}

interface BulkImportSummary {
  publishedJobCount?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  // Per-job detail - only present once the downstream import endpoint (hztl-digital-2026's
  // /api/workable/import) is updated to emit it; the aggregate counts above are all it returns
  // today, so this stays optional and the table below is skipped when it's absent.
  results?: JobResult[];
}

const JOB_STATUS_BADGE: Record<JobResultStatus, ComponentProps<typeof Badge>['colorScheme']> = {
  created: 'success',
  updated: 'primary',
  skipped: 'neutral',
  failed: 'danger',
  deleted: 'warning',
};

type BulkImportState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'success'; summary: BulkImportSummary }
  | { status: 'error'; message: string };

function PagesContextPanel() {
  const { client, error: clientError, isInitialized } = useMarketplaceClient();
  const [pagesContext, setPagesContext] = useState<PagesContext>();
  const [sitecoreContextId, setSitecoreContextId] = useState<string>();
  const [syncLookup, setSyncLookup] = useState<SyncLookupResult | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });
  // `undefined` = not looked up yet, `null` = looked up and there isn't one (unset field or the
  // lookup failed) - see the loading-gate comment below for why a failure must still resolve
  // out of `undefined` rather than leaving the whole panel stuck on "Loading...".
  const [careersRootItemId, setCareersRootItemId] = useState<string | null>();
  const [bulkImportState, setBulkImportState] = useState<BulkImportState>({ status: 'idle' });

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

  useEffect(() => {
    if (clientError || !isInitialized || !client) {
      return;
    }
    client
      .query('application.context')
      .then((result) => setSitecoreContextId(extractSitecoreContextId(result)))
      .catch((err) => console.error('Error retrieving application.context:', err));
  }, [client, clientError, isInitialized]);

  const itemId = pagesContext?.pageInfo?.id;
  const language = pagesContext?.pageInfo?.language;

  useEffect(() => {
    if (!client || !itemId || !language || !sitecoreContextId) {
      return;
    }

    const key = `${itemId}::${language}`;
    let cancelled = false;

    client
      .mutate('xmc.authoring.graphql', {
        params: {
          query: { sitecoreContextId },
          body: { query: ITEM_QUERY, variables: { itemId, language } },
        },
      })
      .then((result) => {
        if (cancelled) return;
        const item = unwrapGraphQLItem(result);
        if (!item) {
          setSyncLookup({
            key,
            syncId: null,
            title: null,
            error: 'Could not read this item from Sitecore.',
          });
          return;
        }
        // `null` here covers both "fragment didn't match" (wrong item type) and "field is
        // genuinely empty" - normalized so it's distinguishable from "still loading" (no
        // result yet for this key).
        setSyncLookup({ key, syncId: extractSyncId(item), title: extractTitle(item), error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error fetching the force-sync id:', err);
        setSyncLookup({
          key,
          syncId: null,
          title: null,
          error: 'Could not read this item from Sitecore.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [client, itemId, language, sitecoreContextId]);

  useEffect(() => {
    if (!client || !sitecoreContextId) {
      return;
    }
    let cancelled = false;

    client
      .mutate('xmc.authoring.graphql', {
        params: {
          query: { sitecoreContextId },
          body: {
            query: CAREERS_ROOT_QUERY,
            variables: { path: CAREERS_ROOT_SETTINGS_PATH, language: language ?? 'en' },
          },
        },
      })
      .then((result) => {
        if (cancelled) return;
        setCareersRootItemId(extractCareersRootId(unwrapGraphQLItem(result)));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error resolving the careers root item id:', err);
        setCareersRootItemId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [client, sitecoreContextId, language]);

  // The lookup result is only "current" once it was recorded for this exact itemId/language -
  // otherwise it's stale (from a previous item) or absent (still loading), so `syncId` reads as
  // `undefined` in both of those cases, same as before this used a ref-free derived value
  // instead of resetting state at the top of the effect above.
  const currentKey = itemId && language ? `${itemId}::${language}` : null;
  const isCurrent = syncLookup?.key === currentKey;
  const syncId = isCurrent ? syncLookup.syncId : undefined;
  const jobTitle = isCurrent ? syncLookup.title : undefined;
  const itemLookupError = isCurrent ? syncLookup.error : null;

  const isCareersRoot =
    !!itemId && !!careersRootItemId && normalizeItemId(itemId) === normalizeItemId(careersRootItemId);

  // A stale "Synced"/"No update needed"/error message from the previously open item must not
  // keep showing after switching to a different Career Detail page. Compared during render
  // (React's documented pattern for resetting state on a prop/key change) rather than in a
  // useEffect, which would setState synchronously and trigger an extra cascading render.
  const lastSyncKeyRef = useRef(currentKey);
  if (lastSyncKeyRef.current !== currentKey) {
    lastSyncKeyRef.current = currentKey;
    setSyncState({ status: 'idle' });
  }

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

  const handleBulkImport = useCallback(async () => {
    setBulkImportState({ status: 'syncing' });
    try {
      const res = await fetch('/api/bulk-import', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setBulkImportState({ status: 'error', message: body.error ?? `Request failed (${res.status})` });
        return;
      }
      setBulkImportState({
        status: 'success',
        summary: {
          publishedJobCount: body.publishedJobCount,
          created: body.created,
          updated: body.updated,
          skipped: body.skipped,
          failed: body.failed,
          results: Array.isArray(body.results) ? body.results : undefined,
        },
      });
      client?.mutate('pages.reloadCanvas').catch((err) => {
        console.error('pages.reloadCanvas failed after a successful bulk import:', err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBulkImportState({ status: 'error', message });
    }
  }, [client]);

  return (
    <Card elevation="sm" padding="md" className="mx-auto my-8 w-full max-w-[600px]">
      <CardHeader>
        <h3 className="text-lg leading-none font-semibold">
          {isCareersRoot ? 'Workable Bulk Sync' : 'Workable Force Sync'}
        </h3>
      </CardHeader>
      <CardContent>
        {!isInitialized || itemId === undefined || careersRootItemId === undefined ? (
          <div role="status" aria-label="Loading page context">
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : isCareersRoot ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-body-text">
              Bulk import every published Workable job into Sitecore.
            </p>
            <Button onClick={handleBulkImport} disabled={bulkImportState.status === 'syncing'} className="self-start">
              {bulkImportState.status === 'syncing' ? 'Importing...' : 'Bulk Import'}
            </Button>
            {bulkImportState.status === 'success' && (
              <>
                <Alert variant="success">
                  <AlertDescription>
                    Done - {bulkImportState.summary.created ?? 0} created, {bulkImportState.summary.updated ?? 0}{' '}
                    updated, {bulkImportState.summary.skipped ?? 0} skipped
                    {bulkImportState.summary.failed ? `, ${bulkImportState.summary.failed} failed` : ''}.
                  </AlertDescription>
                </Alert>
                {bulkImportState.summary.results && bulkImportState.summary.results.length > 0 && (
                  <Table
                    size="sm"
                    maxWidth="100%"
                    maxHeight="280px"
                    containerClassName="border border-border"
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>Career title</TableHead>
                        <TableHead>Job ID</TableHead>
                        <TableHead>Sitecore item</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bulkImportState.summary.results.map((job) => (
                        <TableRow key={job.jobId}>
                          <TableCell className="whitespace-normal">{job.title}</TableCell>
                          <TableCell>{job.jobId}</TableCell>
                          <TableCell>{job.sitecoreItemId ?? '—'}</TableCell>
                          <TableCell>
                            <Badge colorScheme={JOB_STATUS_BADGE[job.status]}>{job.status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </>
            )}
            {bulkImportState.status === 'error' && (
              <Alert variant="danger">
                <AlertDescription>Bulk import failed: {bulkImportState.message}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : syncId === undefined ? (
          <div role="status" aria-label="Loading page context">
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : syncId === null ? (
          <p className="text-sm text-subtle-text">
            {itemLookupError ?? `This item is not a ${ITEM_GRAPHQL_TYPE}.`}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm text-body-text">
                <span className="font-semibold">Career</span> - {jobTitle || 'Untitled job'}
              </p>
              <p className="text-sm text-body-text">
                <span className="font-semibold">Job Id</span> - {syncId}
              </p>
            </div>
            <Button onClick={handleForceSync} disabled={syncState.status === 'syncing'} className="self-start">
              {syncState.status === 'syncing' ? 'Syncing...' : 'Force Sync'}
            </Button>
            {syncState.status === 'success' && (
              <Alert variant="success">
                <AlertDescription>
                  {syncState.operation === 'skipped' ? 'No update needed.' : `Synced (${syncState.operation}).`}
                </AlertDescription>
              </Alert>
            )}
            {syncState.status === 'error' && (
              <Alert variant="danger">
                <AlertDescription>Sync failed: {syncState.message}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PagesContextPanel;
