# betternow design system — how to build with it

betternow is an interest-free healthcare payment-plan product (South Africa). Brand voice: calm, trustworthy, navy + teal. This library is a **curated presentational subset** of the betternow web app: brand chrome, status/metric widgets, and the marketing icon set. Components are real React and styled with **Tailwind v4 utility classes**.

## Wrapping & setup

Two families, one rule that matters:

- **Marketing chrome — `SiteHeader`, `SiteFooter` — MUST be wrapped in `<div className="lp-root">`.** That class scope defines the brand tokens (`--navy`, `--teal`, …) and the **Poppins** brand font. Without it the wordmark/nav render in a fallback font with no brand palette.
- **Everything else needs no wrapper.** The widgets (`StatCard`, `CollectionStatusBadge`, `DefaultFreezeBanner`, `ApprovedBalanceCard`, `PendingPlanCard`) and all `*Icon` components use plain Tailwind utilities and render standalone.

No theme provider, no context. Import the real stylesheet (`styles.css`) once — it carries the Tailwind utilities, the brand tokens, and the component CSS.

## Styling idiom — Tailwind v4 utilities

Style your own layout/glue with **Tailwind utility classes**, the same idiom the components use. There are no CSS-module class maps to import.

- **Brand colors**: navy `#13294B`, teal `#15A89E`. Under `.lp-root` these are the CSS vars `var(--navy)` / `var(--teal)`; elsewhere use Tailwind arbitrary values, e.g. `bg-[#13294B]`, `text-[#15A89E]`. The teal is the accent/CTA color; navy is text/surfaces.
- **Status semantics** use standard Tailwind scales: green = collected/good, red = overdue/failed/default, amber = awaiting/warn, blue = upcoming, gray = written-off/neutral.
- **Icons** (`HeartIcon`, `ShieldCheckIcon`, `CashIcon`, …) are `currentColor` SVGs — **tint by setting text color on the parent** (`<span className="text-[#13294B]"><ShieldCheckIcon/></span>`). They render at 24×24; scale with a transform if you need them larger.

## Style components via PROPS, not className overrides

The widgets carry the design language through their own props — don't restyle them, drive them:

- `CollectionStatusBadge` — `bucket`: `'upcoming' | 'overdue' | 'processing' | 'failed' | 'collected' | 'written_off' | 'defaulted'` (picks label + color).
- `StatCard` — `label`, `value`, optional `sublabel`, `tone`: `'default' | 'good' | 'warn' | 'alert'`, optional `href` (turns the whole card into a link).
- `DefaultFreezeBanner` — `frozen: boolean` (renders nothing when false; drop it in unconditionally).
- `ApprovedBalanceCard` — `limit: number | null`, `available: number` (renders nothing when `limit` is null).
- `PendingPlanCard` — `planId`, `totalAmount`, `practiceName`, `declinePlan` (+ optional invoice/reference).

Read each component's `.prompt.md` and `.d.ts` for the full prop contract before composing; read `styles.css` for the token/utility source of truth.

## Idiomatic snippet

```jsx
// A metric row + a status pill — plain Tailwind for the layout glue.
<div className="grid grid-cols-2 gap-3 max-w-xl">
  <StatCard label="Collected · 30d" value="R84,200" tone="good" href="/admin/collections" />
  <StatCard label="Overdue" value="R6,150" tone="warn" />
  <div className="flex items-center gap-2">
    <CollectionStatusBadge bucket="overdue" />
    <CollectionStatusBadge bucket="collected" />
  </div>
</div>

// Brand chrome — remember the .lp-root wrapper.
<div className="lp-root">
  <SiteHeader />
</div>
```
