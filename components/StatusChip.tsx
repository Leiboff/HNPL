/**
 * Single source of truth for status-chip chrome. Every chip in the app
 * (plan status, payment status, anything new added later) renders through
 * this component so height, padding, radius, and font size stay identical
 * — only the `cls` (background + text colour) and `label` vary.
 *
 * If you find yourself writing `inline-flex items-center rounded-full
 * px-… py-… text-xs font-medium` inline somewhere, replace it with
 * <StatusChip /> instead.
 */
export default function StatusChip({
  label,
  cls,
}: {
  label: string;
  cls:   string;
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
