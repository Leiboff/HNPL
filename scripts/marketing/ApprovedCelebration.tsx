// ─── ApprovedCelebration — marketing composition, not (yet) an app screen ──
//
// The "you're approved" moment for the landing page's device image, drawn
// in the v5 portal language from the app's own pieces: the PatientScreen
// navy shell, the Action Centre bell, formatRand and the brand tokens. The
// real patient layout (bottom nav, Poppins scope) wraps it at capture time.
//
// The app has no such screen today. Written so it can be lifted into
// app/patient as one when it gets built; until then it lives here, outside
// app/, so it can never be routed or shipped.
import PatientScreen from '@/app/patient/PatientScreen';
import ActionCentreBell from '@/app/patient/ActionCentreBell';
import { formatRand } from '@/app/patient/_format';

export type CelebrationProps = {
  firstName: string;
  allowance: number;
};

// Deterministic confetti: [left%, top px, width, height, rotate deg, colour]
// Around the badge the pieces can come inwards; below it they keep to the
// outer 8% so they never touch the headline, the figure or its caption.
const CONFETTI: Array<[number, number, number, number, number, string]> = [
  [9, 150, 13, 4, 28, 'var(--brand-teal-bright)'],
  [24, 196, 6, 6, 0, 'rgba(255,255,255,.55)'],
  [31, 132, 10, 4, -24, 'rgba(255,255,255,.35)'],
  [68, 140, 13, 4, 36, 'var(--brand-teal-bright)'],
  [77, 212, 6, 6, 0, 'rgba(92,217,206,.8)'],
  [89, 170, 9, 4, -40, 'rgba(255,255,255,.4)'],
  [4, 330, 10, 4, -30, 'rgba(255,255,255,.3)'],
  [94, 352, 6, 6, 0, 'var(--brand-teal-bright)'],
  [3, 470, 5, 5, 0, 'rgba(92,217,206,.7)'],
  [94, 492, 11, 4, 18, 'rgba(255,255,255,.3)'],
  [6, 600, 7, 7, 0, 'rgba(255,255,255,.18)'],
  [91, 620, 12, 4, -22, 'rgba(92,217,206,.55)'],
];

export default function ApprovedCelebration({ firstName, allowance }: CelebrationProps) {
  const header = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15.5px] font-semibold text-white">Hi {firstName}</span>
        <ActionCentreBell onDark />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {CONFETTI.map(([l, t, w, h, r, c], i) => (
          <span key={i} className="absolute rounded-full" style={{ left: `${l}%`, top: t, width: w, height: h, transform: `rotate(${r}deg)`, background: c }} />
        ))}
      </div>
      <div className="relative mt-[100px] mb-[96px] flex flex-col items-center text-center">
        <span
          className="flex h-[76px] w-[76px] items-center justify-center rounded-full"
          style={{ background: 'rgba(25,194,182,.16)', boxShadow: '0 0 0 12px rgba(25,194,182,.07)', color: 'var(--brand-teal-bright)' }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
        <p className="mt-[42px] text-[34px] font-bold text-white" style={{ letterSpacing: '-.03em', lineHeight: 1.1 }}>
          You&rsquo;re approved!
        </p>
        <p className="mt-[10px] text-[15px]" style={{ color: 'rgba(255,255,255,.66)' }}>
          Your interest-free healthcare allowance
        </p>
        <p data-testid="approved-allowance" className="mt-[44px] font-bold tabular-nums" style={{ fontSize: 78, lineHeight: '.95', letterSpacing: '-.045em', color: 'var(--brand-teal-bright)' }}>
          {formatRand(allowance).split('.')[0]}
        </p>
        <p className="mt-[36px] text-[14px]" style={{ color: 'rgba(255,255,255,.6)' }}>
          Ready to use at any <span className="font-semibold text-white">better</span><span className="font-semibold" style={{ color: 'var(--brand-teal-bright)' }}>now</span> practice
        </p>
      </div>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <span className="bn-btn-teal block text-center text-[15.5px] font-semibold text-white rounded-tile py-[17px]" style={{ boxShadow: '0 10px 22px -12px rgba(21,168,158,.9)' }}>
        Find care near you
      </span>
    </PatientScreen>
  );
}
