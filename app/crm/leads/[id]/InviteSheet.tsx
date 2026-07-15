'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { markSigned } from '../actions';
import { listMyGmailAccounts, sendComposedEmail, type ComposeAccount } from './composeEmail';
import { substituteMergeFields } from '@/lib/gmail/mergeFields';
import type { LeadContact } from './contactsActions';

// ─── Invite sheet — Mark signed → invite ────────────────────────────
//
// Two paths: SEND VIA GMAIL (composes with the user's connected
// account) or COPY LINK (unchanged from prior UX). Contact picker
// defaults to primary; changing it re-writes the invite's locked
// email + name.

const DEFAULT_SUBJECT =
  'Next step for {{practice_name}} — set up your betternow admin';

const DEFAULT_BODY =
  'Hi {{contact_first_name}},\n\n'
  + 'Thanks for signing on with betternow for {{practice_name}}. '
  + 'Here’s your setup link — it prefills what we already have on '
  + 'file so you only need to complete banking and confirm your details:\n\n'
  + '{{invite_link}}\n\n'
  + 'The link is single-use per practice. Reply here if anything doesn’t look right and we’ll sort it out.\n\n'
  + 'Best,\n{{my_name}}';

export default function InviteSheet({
  leadId, practiceName, contacts,
  onClose, onSuccess, onOptimisticEmail, onError,
}: {
  leadId: string;
  practiceName: string;
  contacts: LeadContact[];
  onClose: () => void;
  onSuccess: (inviteUrl: string) => void;
  onOptimisticEmail: (title: string, sentFrom: string) => void;
  onError: (msg: string) => void;
}) {
  const primary = useMemo(
    () => contacts.find(c => c.is_primary) ?? contacts[0] ?? null,
    [contacts],
  );
  const [contactId, setContactId] = useState<string>(primary?.id ?? '');
  const [subject,   setSubject]   = useState(DEFAULT_SUBJECT);
  const [body,      setBody]      = useState(DEFAULT_BODY);
  const [accounts,  setAccounts]  = useState<ComposeAccount[] | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [aliasId,   setAliasId]   = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    void listMyGmailAccounts().then(rows => {
      setAccounts(rows);
      const preferred = rows.find(r => r.isDefault) ?? rows[0] ?? null;
      if (preferred) {
        if (preferred.kind === 'alias') setAliasId(preferred.id);
        else                            setAccountId(preferred.id);
      }
    });
  }, []);

  const contact = contacts.find(c => c.id === contactId) ?? primary;
  const recipient = contact?.email ?? '';
  const canSendViaGmail = !!(recipient && (accountId || aliasId));

  const previewSubject = useMemo(
    () => substituteMergeFields(subject, {
      practice_name:      practiceName,
      contact_first_name: contact?.first_name ?? null,
      contact_last_name:  contact?.last_name  ?? null,
    }),
    [subject, practiceName, contact],
  );
  const previewBody = useMemo(
    () => substituteMergeFields(body, {
      practice_name:      practiceName,
      contact_first_name: contact?.first_name ?? null,
      contact_last_name:  contact?.last_name  ?? null,
      invite_link:        '<invite link — generated on send>',
    }),
    [body, practiceName, contact],
  );

  function copyLink() {
    startTransition(async () => {
      const res = await markSigned(leadId, { contactId: contactId || null });
      if (res.error || !res.inviteUrl) return onError(res.error ?? 'Could not create invite.');
      try { await navigator.clipboard.writeText(res.inviteUrl); } catch { /* ignore */ }
      onSuccess(res.inviteUrl);
    });
  }

  function sendViaGmail() {
    if (!recipient) return onError('The chosen contact has no email address.');
    if (!accountId && !aliasId) return onError('Pick a Gmail account to send from.');
    startTransition(async () => {
      const signed = await markSigned(leadId, { contactId: contactId || null });
      if (signed.error || !signed.inviteUrl) return onError(signed.error ?? 'Could not create invite.');

      const resolvedBody = substituteMergeFields(body, {
        practice_name:      practiceName,
        contact_first_name: contact?.first_name ?? null,
        contact_last_name:  contact?.last_name  ?? null,
        invite_link:        signed.inviteUrl,
      });
      const resolvedSubject = substituteMergeFields(subject, {
        practice_name:      practiceName,
        contact_first_name: contact?.first_name ?? null,
        contact_last_name:  contact?.last_name  ?? null,
      });

      const chosen = accounts?.find(a =>
        (aliasId && a.kind === 'alias'   && a.id === aliasId) ||
        (accountId && a.kind === 'account' && a.id === accountId),
      );
      // Optimistic activity insert so the timeline updates immediately;
      // sendComposedEmail will insert the real row server-side.
      if (chosen) {
        onOptimisticEmail(`Email sent: ${resolvedSubject.slice(0, 60)}`, chosen.gmailAddress);
      }

      const res = await sendComposedEmail({
        leadId,
        subject:                 resolvedSubject,
        body:                    resolvedBody,
        accountId:               accountId ?? undefined,
        aliasId:                 aliasId   ?? undefined,
        recipientEmailOverride:  recipient,
      });
      if (res.error) return onError(res.error);
      onSuccess(signed.inviteUrl);
    });
  }

  const hasNoContactEmails = contacts.every(c => !c.email);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="invite-sheet">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Send invite</h3>
          <button type="button" onClick={onClose} disabled={pending} className="text-xs text-gray-500">Close</button>
        </div>
        <p className="text-xs text-gray-500">
          The lead will move to &lsquo;signed&rsquo;. The signup link prefills what we have on file — email locked to the chosen contact, other fields editable.
        </p>

        <div className="space-y-2">
          <label className="text-xs block">
            <span className="block font-medium text-gray-700 mb-1">Send to</span>
            <select
              value={contactId}
              onChange={e => setContactId(e.target.value)}
              disabled={pending}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
              data-testid="invite-contact-picker"
            >
              {contacts.map(c => (
                <option key={c.id} value={c.id} disabled={!c.email}>
                  {c.first_name} {c.last_name}{c.is_primary ? ' (primary)' : ''}{c.email ? ` · ${c.email}` : ' · no email'}
                </option>
              ))}
            </select>
          </label>
          {hasNoContactEmails && (
            <p className="text-[11px] text-red-700" role="alert" data-testid="invite-no-emails">
              None of the contacts on this lead has an email. Add an email to at least one contact to send an invite.
            </p>
          )}
        </div>

        {accounts && accounts.length > 0 && (
          <div>
            <label className="text-xs block">
              <span className="block font-medium text-gray-700 mb-1">Send from</span>
              <select
                value={aliasId ?? accountId ?? ''}
                onChange={e => {
                  const id = e.target.value;
                  const a = accounts.find(x => x.id === id);
                  if (!a) { setAccountId(null); setAliasId(null); return; }
                  if (a.kind === 'alias') { setAliasId(a.id);   setAccountId(null); }
                  else                    { setAccountId(a.id); setAliasId(null); }
                }}
                disabled={pending}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                data-testid="invite-account-picker"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.gmailAddress}{a.kind === 'alias' && a.via !== a.gmailAddress ? ` (via ${a.via})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {accounts && accounts.length === 0 && (
          <p className="text-[11px] text-amber-700" data-testid="invite-no-gmail">
            You haven&rsquo;t connected a Gmail account, so &ldquo;send via Gmail&rdquo; isn&rsquo;t available. You can still copy the link and paste it into your own email client.
          </p>
        )}

        <label className="text-xs block">
          <span className="block font-medium text-gray-700 mb-1">Subject</span>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            disabled={pending}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            data-testid="invite-subject"
          />
        </label>
        <label className="text-xs block">
          <span className="block font-medium text-gray-700 mb-1">Message</span>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            disabled={pending}
            rows={10}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-mono resize-y"
            data-testid="invite-body"
          />
          <span className="mt-1 text-[10px] text-gray-500 block">
            Merge fields: {'{{practice_name}} {{contact_first_name}} {{invite_link}} {{my_name}}'} — {'{{invite_link}}'} is generated on send.
          </span>
        </label>

        <details className="text-xs" data-testid="invite-preview">
          <summary className="cursor-pointer text-[#15A89E]">Preview</summary>
          <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 space-y-1">
            <p><span className="text-gray-500">Subject:</span> {previewSubject}</p>
            <pre className="whitespace-pre-wrap text-xs text-gray-800">{previewBody}</pre>
          </div>
        </details>

        <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-gray-100">
          <button
            type="button"
            onClick={copyLink}
            disabled={pending}
            className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm font-medium disabled:opacity-60"
            data-testid="invite-copy-link"
          >
            {pending ? 'Working…' : 'Copy link'}
          </button>
          <button
            type="button"
            onClick={sendViaGmail}
            disabled={pending || !canSendViaGmail}
            className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
            data-testid="invite-send-gmail"
          >
            {pending ? 'Sending…' : 'Send via Gmail'}
          </button>
        </div>
      </div>
    </div>
  );
}
