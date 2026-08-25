// Shared field/button styling for the onboarding step forms.
//
// Extracted when the combined identity+salary step was split into two
// separate steps, so the two forms cannot visually drift apart. Both
// were byte-identical before the split; keeping one copy makes that
// guaranteed rather than coincidental.

export const INPUT_CLS =
  'h-[56px] w-full rounded-[14px] border-[1.5px] border-[#E2E8EE] bg-[#FBFCFD] px-4 text-[16px] tracking-[0.06em] ' +
  'text-[#13294B] outline-none transition-colors placeholder:text-[#A8B4C2] ' +
  'focus:border-[#15A89E] focus:bg-white focus:ring-4 focus:ring-[#15A89E]/15';

export const BUTTON_CLS =
  'flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all ' +
  'disabled:opacity-45 disabled:cursor-not-allowed';
