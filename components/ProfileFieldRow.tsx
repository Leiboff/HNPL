/**
 * One row in a profile-style field list: a leading icon, an eyebrow label
 * with its value (or edit form) underneath, and an optional trailing action
 * (the edit button, or Cancel/Save while editing).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────
 *
 * Personal details used to be a 2-column grid of locked fields followed by
 * three separately-built rows (phone, salary date, salary amount), each with
 * its own `border-t pt-4` wrapper and its own copy of the eyebrow-label
 * markup. Nothing was WRONG with any one of them, but side by side they
 * didn't read as one list — spacing between rows varied by how each field
 * happened to wrap itself, and only some rows had a leading icon.
 *
 * Every field on this screen now renders through this one row shape, laid
 * out as siblings under a `divide-y` container in
 * app/patient/account/personal/page.tsx — so the divider lines and the
 * gap on each side of them come from one place instead of six.
 */

export type ProfileFieldIconName = 'name' | 'id' | 'email' | 'phone' | 'calendar' | 'income';

const ICON_PATHS: Record<ProfileFieldIconName, React.ReactNode> = {
  name: (
    <>
      <circle cx="12" cy="8.5" r="3.3" />
      <path d="M5.5 20c1-3.2 3.6-5 6.5-5s5.5 1.8 6.5 5" />
    </>
  ),
  id: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
      <circle cx="8" cy="12" r="2" />
      <path d="M12.5 10h6M12.5 14h3.5" />
    </>
  ),
  email: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.2" />
      <path d="m3.5 7 8.5 6.2L20.5 7" />
    </>
  ),
  phone: (
    <path d="M7 3.5c.9 0 1.7.6 2 1.4l.8 2c.3.8.1 1.7-.5 2.3l-1 1c1 2.2 2.7 3.9 4.9 4.9l1-1c.6-.6 1.5-.8 2.3-.5l2 .8c.8.3 1.4 1.1 1.4 2v1.7c0 1.3-1.1 2.3-2.4 2.1-6.7-1-12-6.3-13-13C4.4 5.6 5.4 4.5 6.7 4.5H7Z" />
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="15.5" rx="2.2" />
      <path d="M3 9.5h18M8 3v3.5M16 3v3.5" />
    </>
  ),
  income: (
    <>
      <rect x="2" y="6.5" width="20" height="11" rx="2.2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M5.5 6.5v11M18.5 6.5v11" />
    </>
  ),
};

function RowIcon({ name }: { name: ProfileFieldIconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={19}
      height={19}
      fill="none"
      stroke="#13294B"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none mt-0.5"
      data-testid="profile-field-icon"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export default function ProfileFieldRow({
  icon,
  label,
  action,
  children,
  testId,
}: {
  icon:    ProfileFieldIconName;
  label:   string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0 flex items-start gap-3" data-testid={testId}>
      <RowIcon name={icon} />
      <div className="min-w-0 flex-1">
        <p
          className="text-[11px] font-semibold uppercase tracking-widest mb-1.5"
          style={{ color: '#13294B', opacity: 0.45 }}
        >
          {label}
        </p>
        {children}
      </div>
      {action && <div className="flex-none">{action}</div>}
    </div>
  );
}
