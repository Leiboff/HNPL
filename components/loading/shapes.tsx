/**
 * Shape compositions — the reusable route-level skeletons.
 *
 * ./Skeleton.tsx has the atoms; this file has the four page shapes the app
 * actually uses, so a route's loading.tsx is a couple of lines and no
 * route hand-rolls its own arrangement of lines and boxes.
 *
 * The shapes are named after the LAYOUT they describe, not the route:
 * /practice/bills and /admin/customers are both ListShape, and that is the
 * point — matching the shape is what stops the swap to real content from
 * reflowing, and there are only four shapes in this app.
 *
 * Every shape is a plain server component and every one wraps itself in a
 * SkeletonRegion, so a caller cannot accidentally ship a skeleton that is
 * silent to a screen reader and static under reduced motion. Callers pass
 * `label` to say what is loading.
 */

import {
  SkeletonRegion,
  SkeletonCard,
  SkeletonLine,
  SkeletonBlock,
  SkeletonRows,
  SkeletonStatTiles,
  SkeletonFormFields,
} from './Skeleton';

/** The page padding the real surfaces use, so nothing shifts on swap. */
const PAGE = 'mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 space-y-6';

/**
 * DASHBOARD — a heading, a hero card, a row of stat tiles, a list.
 * /practice, /brand, /admin, /crm, /provider.
 */
export function DashboardShape({ label = 'Loading dashboard' }: { label?: string }) {
  return (
    <SkeletonRegion label={label} className={PAGE}>
      <div className="space-y-2">
        <SkeletonLine w="w-48" h="h-7" />
        <SkeletonLine w="w-64" h="h-4" />
      </div>
      <SkeletonCard className="space-y-4">
        <SkeletonLine w="w-32" h="h-3" />
        <SkeletonLine w="w-40" h="h-9" />
        <SkeletonBlock h="h-11" className="max-w-xs" />
      </SkeletonCard>
      <SkeletonStatTiles tiles={3} />
      <SkeletonCard>
        <SkeletonLine w="w-28" h="h-5" className="mb-2" />
        <SkeletonRows rows={4} />
      </SkeletonCard>
    </SkeletonRegion>
  );
}

/**
 * LIST — a heading, optional filter bar, then rows.
 * /practice/bills, /practice/payouts, /patient/orders, /admin/customers,
 * /admin/practices, /crm/leads, /admin/groups.
 */
export function ListShape({
  label = 'Loading',
  rows = 6,
  filters = true,
}: {
  label?: string;
  rows?: number;
  filters?: boolean;
}) {
  return (
    <SkeletonRegion label={label} className={PAGE}>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <SkeletonLine w="w-40" h="h-7" />
          <SkeletonLine w="w-56" h="h-4" />
        </div>
        <SkeletonLine w="w-28" h="h-10" />
      </div>
      {filters && (
        <div className="flex flex-wrap gap-2">
          <SkeletonLine w="w-24" h="h-9" />
          <SkeletonLine w="w-24" h="h-9" />
          <SkeletonLine w="w-32" h="h-9" />
        </div>
      )}
      <SkeletonCard>
        <SkeletonRows rows={rows} />
      </SkeletonCard>
    </SkeletonRegion>
  );
}

/**
 * DETAIL — a back row, a title block, then stacked detail cards.
 * /patient/orders/[planId], /admin/practices/[id], /crm/leads/[id],
 * /admin/customers/[patientId], /admin/collections/[paymentId].
 */
export function DetailShape({
  label = 'Loading details',
  cards = 3,
}: {
  label?: string;
  cards?: number;
}) {
  return (
    <SkeletonRegion label={label} className={PAGE}>
      <SkeletonLine w="w-20" h="h-4" />
      <div className="space-y-2">
        <SkeletonLine w="w-56" h="h-7" />
        <SkeletonLine w="w-32" h="h-4" />
      </div>
      {Array.from({ length: cards }).map((_, i) => (
        <SkeletonCard key={i} className="space-y-3">
          <SkeletonLine w="w-32" h="h-5" />
          <SkeletonLine w="w-full" />
          <SkeletonLine w="w-4/5" />
          <SkeletonLine w="w-2/3" />
        </SkeletonCard>
      ))}
    </SkeletonRegion>
  );
}

/**
 * AUTH CARD — a narrow centred card on the tinted auth background.
 * /login, /signup/patient, /update-password, /verify-email, /verify-phone,
 * /auth/confirmed.
 *
 * A separate shape from FormShape because the auth surfaces are not pages
 * with a heading and a form on them — they are a single centred card on a
 * gradient wash, and using the wide page shape here would flash a
 * full-width layout that never appears. The background and radial
 * gradients are copied from the real shells so only the card contents are
 * grey.
 */
export function AuthCardShape({
  label = 'Loading',
  fields = 2,
}: {
  label?: string;
  fields?: number;
}) {
  return (
    <SkeletonRegion
      label={label}
      className="flex min-h-screen items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage:
          'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-8 space-y-6">
          <div className="flex justify-center">
            <SkeletonLine w="w-32" h="h-7" />
          </div>
          <div className="space-y-2 text-center">
            <SkeletonLine w="w-48" h="h-6" className="mx-auto" />
            <SkeletonLine w="w-64" h="h-3" className="mx-auto" />
          </div>
          <SkeletonFormFields fields={fields} />
        </div>
      </div>
    </SkeletonRegion>
  );
}

/**
 * FORM — a title and a card of fields.
 * /practice/bills/new, /practice/setup, /practice/details, /brand/*-branch,
 * /provider/profile, /practice/settings.
 */
export function FormShape({
  label = 'Loading form',
  fields = 4,
}: {
  label?: string;
  fields?: number;
}) {
  return (
    <SkeletonRegion label={label} className={PAGE}>
      <div className="space-y-2">
        <SkeletonLine w="w-52" h="h-7" />
        <SkeletonLine w="w-72" h="h-4" />
      </div>
      <SkeletonCard>
        <SkeletonFormFields fields={fields} />
      </SkeletonCard>
    </SkeletonRegion>
  );
}
