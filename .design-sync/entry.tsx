// design-sync curated entry — re-exports exactly the presentational,
// self-contained components that make up the betternow design system.
// next/link is aliased to a plain-anchor shim via tsconfig.dssync paths.
export { default as SiteHeader } from '@/app/_landing/SiteHeader';
export { default as SiteFooter } from '@/app/_landing/SiteFooter';
export { default as CollectionStatusBadge } from '@/app/admin/_components/CollectionStatusBadge';
export { default as StatCard } from '@/app/admin/_components/StatCard';
export { default as DefaultFreezeBanner } from '@/app/patient/DefaultFreezeBanner';
export { default as ApprovedBalanceCard } from '@/app/patient/ApprovedBalanceCard';
export { default as PendingPlanCard } from '@/app/patient/PendingPlanCard';
export {
  HeartIcon, CalendarIcon, CheckIcon, PencilIcon, ClockIcon, CashIcon,
  EcgIcon, BoltIcon, ShieldIcon, ShieldCheckIcon, CardIcon, PeopleIcon,
  DocCheckIcon, BrushIcon, LayersIcon, PopiaIcon,
} from '@/app/_landing/icons';
