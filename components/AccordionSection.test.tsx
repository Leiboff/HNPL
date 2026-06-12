import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import AccordionSection from './AccordionSection';

function Harness({
  initialOpen = false,
  summary = 'collapsed summary',
  onToggleSpy,
}: {
  initialOpen?: boolean;
  summary?: React.ReactNode;
  onToggleSpy?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <AccordionSection
      title="Personal details"
      summary={summary}
      open={open}
      onToggle={() => { setOpen((o) => !o); onToggleSpy?.(); }}
    >
      <p>panel body content</p>
    </AccordionSection>
  );
}

describe('AccordionSection — disclosure pattern', () => {
  it('renders a button with aria-expanded=false when collapsed', () => {
    render(<Harness initialOpen={false} />);
    const button = screen.getByRole('button', { name: /personal details/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('button aria-controls points at the panel id', () => {
    render(<Harness initialOpen={false} />);
    const button   = screen.getByRole('button', { name: /personal details/i });
    const controls = button.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // The panel exists in the DOM (even when collapsed) and matches the id.
    const panel = document.getElementById(controls!);
    expect(panel).toBeInTheDocument();
  });

  it('panel is aria-hidden when collapsed and visible to AT when open', async () => {
    render(<Harness initialOpen={false} />);
    const button = screen.getByRole('button', { name: /personal details/i });
    const controls = button.getAttribute('aria-controls')!;
    const panel    = document.getElementById(controls)!;

    expect(panel).toHaveAttribute('aria-hidden', 'true');

    await userEvent.setup().click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('aria-hidden', 'false');
  });

  it('click toggles open ↔ closed and fires onToggle each time', async () => {
    const spy = vi.fn();
    render(<Harness onToggleSpy={spy} />);
    const button = screen.getByRole('button', { name: /personal details/i });
    const userEv = userEvent.setup();

    await userEv.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await userEv.click(button);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('Enter and Space on the focused button both toggle (native button keyboard behaviour)', async () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: /personal details/i });
    const userEv = userEvent.setup();

    button.focus();
    await userEv.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await userEv.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('AccordionSection — summary visibility', () => {
  it('shows the summary on the right when collapsed', () => {
    render(<Harness initialOpen={false} summary="850101•••••23" />);
    expect(screen.getByTestId('accordion-summary')).toHaveTextContent('850101•••••23');
  });

  it('hides the summary when open (content reveals itself)', () => {
    render(<Harness initialOpen={true} summary="850101•••••23" />);
    expect(screen.queryByTestId('accordion-summary')).not.toBeInTheDocument();
  });

  it('renders no summary node at all when summary is empty', () => {
    render(<Harness initialOpen={false} summary="" />);
    expect(screen.queryByTestId('accordion-summary')).not.toBeInTheDocument();
  });
});

describe('AccordionSection — chevron rotation', () => {
  it('chevron has no rotate class when collapsed', () => {
    const { container } = render(<Harness initialOpen={false} />);
    const svg = container.querySelector('svg[aria-hidden]');
    expect(svg?.className.baseVal ?? svg?.getAttribute('class') ?? '').not.toMatch(/\brotate-180\b/);
  });

  it('chevron has rotate-180 class when open', () => {
    const { container } = render(<Harness initialOpen={true} />);
    const svg = container.querySelector('svg[aria-hidden]');
    expect(svg?.className.baseVal ?? svg?.getAttribute('class') ?? '').toMatch(/\brotate-180\b/);
  });
});
