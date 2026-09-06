import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ReferralList, { type ReferralRow } from './ReferralList';

// ─── What a referral is CALLED, across two eras of this screen ───────────
//
// The refer-a-doctor split changed what the form asks for, and it changed
// what `invitee_name` means on a kind='practice' row:
//
//   before  practice_name = the rooms that were referred
//           invitee_name  = the optional "Who to ask for" contact, if any
//   after   practice_name = the rooms, or the doctor's name where the patient
//                           did not know the rooms' name
//           invitee_name  = the doctor
//
// The schema carries no discriminator between them, and it should not grow
// one for a label. So the title is taken from `practice_name`, which names
// the referred entity in BOTH eras — and this file is here because the
// obvious alternative (prefer the newer, more specific `invitee_name`) reads
// perfectly and silently renames a year of history to whoever answered the
// phone.

const base: ReferralRow = {
  id: 'r1',
  kind: 'practice',
  status: 'pending',
  invitee_name: null,
  invitee_email: null,
  practice_name: null,
  expires_at: null,
  created_at: '2026-09-06T00:00:00Z',
};

const row = (over: Partial<ReferralRow>): ReferralRow[] => [{ ...base, ...over }];

afterEach(cleanup);

describe('a doctor referral is titled by what was referred', () => {
  it('a legacy practice row keeps the practice as its title, not its contact', () => {
    // The regression this file exists for: titling by invitee_name turns
    // "Rosebank Dental" into "Sarah at reception".
    render(<ReferralList rows={row({
      practice_name: 'Rosebank Dental',
      invitee_name:  'Sarah at reception',
    })} />);
    expect(screen.getByText('Rosebank Dental')).toBeTruthy();
    expect(screen.queryByText('Sarah at reception')).toBeNull();
  });

  it('a new row with a practice name shows the practice', () => {
    render(<ReferralList rows={row({
      practice_name: 'Rosebank Dental',
      invitee_name:  'Dr Ayanda Naidoo',
    })} />);
    expect(screen.getByText('Rosebank Dental')).toBeTruthy();
  });

  it('a new row without one shows the doctor, because that is what was stored', () => {
    // referADoctor puts the doctor's name in practice_name when the patient
    // does not know what the rooms are called — it is the name of the thing
    // being referred, so no special case is needed here.
    render(<ReferralList rows={row({
      practice_name: 'Dr Ayanda Naidoo',
      invitee_name:  'Dr Ayanda Naidoo',
    })} />);
    expect(screen.getByText('Dr Ayanda Naidoo')).toBeTruthy();
  });

  it('a scrubbed row says so rather than rendering a blank line', () => {
    // prune_referral_invites() nulls the contact columns on dead invitations
    // (POPIA — see 0145). practice_name is not scrubbed, so this only bites
    // where it was never set.
    render(<ReferralList rows={row({ practice_name: null, invitee_name: null })} />);
    expect(screen.getByText('A doctor')).toBeTruthy();
  });

  it('labels the kind as Doctor', () => {
    render(<ReferralList rows={row({ practice_name: 'Rosebank Dental' })} />);
    expect(screen.getByText('Doctor')).toBeTruthy();
  });
});

describe('a friend referral is titled by whoever was invited', () => {
  it('prefers the name, falls back to the address', () => {
    render(<ReferralList rows={row({
      kind: 'patient', invitee_name: 'Sipho Dlamini', invitee_email: 'sipho@example.com',
    })} />);
    expect(screen.getByText('Sipho Dlamini')).toBeTruthy();
    cleanup();

    render(<ReferralList rows={row({
      kind: 'patient', invitee_name: null, invitee_email: 'sipho@example.com',
    })} />);
    expect(screen.getByText('sipho@example.com')).toBeTruthy();
  });

  it('a scrubbed invitation still says a referral was made', () => {
    render(<ReferralList rows={row({ kind: 'patient' })} />);
    expect(screen.getByText('Someone you invited')).toBeTruthy();
    expect(screen.getByText('Friend')).toBeTruthy();
  });
});
