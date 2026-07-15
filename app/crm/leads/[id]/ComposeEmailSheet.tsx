'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  listTemplates,
  listMyGmailAccounts,
  loadReplyContext,
  previewCompose,
  sendComposedEmail,
  type TemplateRow,
  type ComposeAccount,
  type ReplyContext,
} from './composeEmail';

// ─── Compose email sheet ────────────────────────────────────────────
//
// Modes:
//   • Fresh — default. Send-as picker, template picker, editable To.
//   • Reply — driven by props.replyToActivityId. Send-as is LOCKED to
//             the thread owner, To is prefilled to the counterparty,
//             subject "Re:"-prefixed idempotently, threadId + In-Reply-To
//             + References are stamped server-side on send.

type ContactPickerOption = {
  id:         string;
  first_name: string;
  last_name:  string;
  email:      string | null;
  is_primary: boolean;
};

type Props = {
  open:               boolean;
  onClose:            () => void;
  leadId:             string;
  leadEmail:          string | null;
  practiceName:       string;
  /** When set, opens in reply mode against this timeline activity. */
  replyToActivityId?: string | null;
  /** Full contact list on the lead — enables the To-picker in fresh
   *  compose mode. Omit to keep the legacy single-recipient behaviour. */
  contacts?:          ContactPickerOption[];
};

const LAST_ACCOUNT_KEY = 'crm.compose.lastAccountId';

export default function ComposeEmailSheet({
  open, onClose, leadId, leadEmail, practiceName, replyToActivityId, contacts,
}: Props) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [accounts,  setAccounts]  = useState<ComposeAccount[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [subject, setSubject]       = useState('');
  const [body, setBody]             = useState('');
  const [omitSignature, setOmitSignature] = useState(false);
  const [previewText, setPreview] = useState<{ subject: string; body: string; signatureHtml?: string; signatureText?: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'reauth'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const [replyMode, setReplyMode] = useState<ReplyContext | null>(null);

  // Fresh-compose recipient state. Default: primary contact (== leadEmail).
  // Reply mode ignores this (recipient is locked to counterparty).
  const [recipientEmail, setRecipientEmail] = useState<string>('');
  useEffect(() => {
    if (!open || replyMode) return;
    const withEmail = (contacts ?? []).filter(c => !!c.email);
    const primary   = withEmail.find(c => c.is_primary);
    const initial   = primary?.email ?? withEmail[0]?.email ?? leadEmail ?? '';
    setRecipientEmail(initial);
  }, [open, replyMode, contacts, leadEmail]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [tpls, accs, replyRes] = await Promise.all([
        listTemplates(),
        listMyGmailAccounts(),
        replyToActivityId ? loadReplyContext({ activityId: replyToActivityId }) : Promise.resolve({ context: undefined, error: undefined }),
      ]);
      setTemplates(tpls);
      setAccounts(accs);

      if (replyRes.context) {
        // Reply mode — lock account, prefill To + subject, empty body.
        setReplyMode(replyRes.context);
        setSubject(replyRes.context.subject);
        setBody('');
        setAccountId(replyRes.context.lockedAccount?.id ?? '');
        // Restoring the last-used account from localStorage would let
        // an accidental swap slip in — reply mode ignores it.
      } else {
        setReplyMode(null);
        const stored = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_ACCOUNT_KEY) : null;
        const found  = accs.find(a => a.id === stored);
        const first  = accs[0];
        setAccountId((found ?? first)?.id ?? '');
      }

      if (replyRes.error) {
        setMsg({ kind: 'err', text: replyRes.error });
      }
    })();
  }, [open, replyToActivityId]);

  function pickAccount(id: string) {
    if (replyMode) return;   // send-as is locked in reply mode
    setAccountId(id);
    try { if (typeof window !== 'undefined') window.localStorage.setItem(LAST_ACCOUNT_KEY, id); } catch { /* ignore */ }
  }

  function loadTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find(r => r.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }

  function doPreview() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewCompose({
        leadId,
        templateId: templateId || undefined,
        subject, body,
        omitSignature,
      });
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      if (res.preview) {
        setPreview({
          subject: res.preview.subject,
          body:    res.preview.body,
          signatureHtml: res.preview.signature?.html,
          signatureText: res.preview.signature?.text,
        });
      }
    });
  }

  function doSend() {
    if (!previewText) { doPreview(); return; }
    setMsg(null);
    // Route the picked id to the right server param based on kind.
    const picked  = accounts.find(a => a.id === accountId);
    const lockKind = replyMode?.lockedAccount?.kind;
    const kind    = replyMode ? (lockKind ?? picked?.kind ?? 'account') : (picked?.kind ?? 'account');
    startTransition(async () => {
      const res = await sendComposedEmail({
        leadId,
        subject: previewText.subject,
        body:    previewText.body,
        accountId: kind === 'account' ? (accountId || undefined) : undefined,
        aliasId:   kind === 'alias'   ? (accountId || undefined) : undefined,
        omitSignature,
        replyToActivityId: replyMode?.activityId,
        recipientEmailOverride: replyMode ? undefined : (recipientEmail || undefined),
      });
      if (res.needsReconnect || res.error === 'reply_owner_disconnected') {
        setMsg({
          kind: 'reauth',
          text: res.error === 'reply_owner_disconnected'
            ? 'The address that owns this thread is disconnected. Reconnect it to keep replies threaded.'
            : 'Gmail needs to be reconnected before we can send.',
        });
        return;
      }
      if (res.error === 'reply_threading_headers_unavailable') {
        setMsg({
          kind: 'err',
          text: 'Could not resolve threading headers for this thread — try again in a moment, or open the conversation in Gmail if the problem persists.',
        });
        return;
      }
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      if (res.warning && res.warning.startsWith('alias_rewritten:')) {
        // Sent, but the recipient saw the underlying address. Tell the
        // admin so they can register the alias in Gmail settings.
        const [, expected, actual] = res.warning.split(':');
        setMsg({
          kind: 'err',
          text: `Sent, but Gmail rewrote From from ${expected} to ${actual}. Register the alias under Gmail Settings → Accounts → Send mail as, then future sends will honour it.`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: 'Sent.' });
      setTimeout(onClose, 700);
    });
  }

  if (!open) return null;
  const noAccounts = accounts.length === 0;
  const ownerDisconnected = !!(replyMode && replyMode.ownerDisconnected);

  // Reply-mode "To": show the locked address. Not editable this pass —
  // if you need to change recipients, close and use "Email {practice}".
  const toDisplay = replyMode
    ? replyMode.to
    : leadEmail ?? null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={replyMode ? 'Reply' : 'Compose email'}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6">
        <div
          className="relative bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto"
          data-testid="compose-email-sheet"
          data-mode={replyMode ? 'reply' : 'compose'}
        >
          <div className="sticky top-0 bg-white flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">
              {replyMode ? 'Reply' : `Email ${practiceName}`}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="p-5 space-y-3">

            {replyMode ? (
              <div className="text-xs text-gray-600" data-testid="compose-to-reply">
                <span className="font-medium">To:</span>{' '}
                {toDisplay ?? <span className="text-red-600">(lead has no email — add one first)</span>}
              </div>
            ) : (
              <div className="text-xs text-gray-700 space-y-1" data-testid="compose-to-picker">
                <span className="font-medium">To:</span>{' '}
                {(contacts?.filter(c => !!c.email)?.length ?? 0) > 0 ? (
                  <select
                    value={recipientEmail}
                    onChange={e => setRecipientEmail(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs"
                    data-testid="compose-contact-picker"
                  >
                    {(contacts ?? []).filter(c => !!c.email).map(c => (
                      <option key={c.id} value={c.email!}>
                        {c.first_name} {c.last_name}{c.is_primary ? ' (primary)' : ''} · {c.email}
                      </option>
                    ))}
                    <option value="">Custom…</option>
                  </select>
                ) : null}
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={e => setRecipientEmail(e.target.value)}
                  placeholder="recipient@example.com"
                  className="ml-2 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs w-56"
                  data-testid="compose-to-input"
                />
                {!recipientEmail && (
                  <p className="text-[11px] text-red-600 mt-1">Pick a contact or type a recipient email.</p>
                )}
              </div>
            )}

            {replyMode ? (
              <div
                className="text-xs text-gray-700 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 flex flex-col gap-0.5"
                data-testid="compose-locked-sender"
              >
                <div>
                  <span className="font-medium">Send from:</span>{' '}
                  {replyMode.lockedAccount
                    ? (
                      replyMode.lockedAccount.kind === 'alias'
                        ? `${replyMode.lockedAccount.gmailAddress} via ${replyMode.lockedAccount.via}`
                        : replyMode.lockedAccount.gmailAddress
                    )
                    : '(no account)'}
                </div>
                <div className="text-[10px] text-gray-500">
                  Locked to the address that owns this thread.
                </div>
                {ownerDisconnected && (
                  <div
                    role="alert"
                    className="mt-1 rounded-md border border-amber-200 bg-amber-50 text-amber-900 px-2 py-1"
                    data-testid="compose-owner-disconnected"
                  >
                    That address is disconnected. <a href="/crm/settings" className="underline font-medium">Reconnect →</a>
                  </div>
                )}
              </div>
            ) : (
              <label className="text-xs text-gray-700 block">
                Send as
                <select
                  value={accountId}
                  onChange={e => pickAccount(e.target.value)}
                  disabled={noAccounts}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-50"
                  data-testid="compose-account-picker"
                >
                  {noAccounts && <option value="">(no Gmail connected — go to Settings)</option>}
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.kind === 'alias'
                        ? `${a.label ? `${a.label} — ` : ''}${a.gmailAddress} via ${a.via}`
                        : a.gmailAddress}
                      {a.isDefault ? ' · default' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {!replyMode && (
              <label className="text-xs text-gray-700 block">
                Template
                <select
                  value={templateId}
                  onChange={e => loadTemplate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                  data-testid="compose-template-picker"
                >
                  <option value="">(none)</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}

            <label className="text-xs text-gray-700 block">
              Subject
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                data-testid="compose-subject"
              />
            </label>

            <label className="text-xs text-gray-700 block">
              Body
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={8}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm resize-y font-mono"
                data-testid="compose-body"
              />
              {!replyMode && (
                <p className="mt-1 text-[10px] text-gray-400">
                  Merge fields: {'{{practice_name}}'} · {'{{contact_first_name}}'} · {'{{contact_last_name}}'} · {'{{my_name}}'}
                </p>
              )}
            </label>

            <label className="inline-flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={omitSignature}
                onChange={e => setOmitSignature(e.target.checked)}
                data-testid="compose-omit-signature"
              />
              Omit my signature on this send
            </label>

            {previewText && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs space-y-2" data-testid="compose-preview">
                <p className="font-semibold text-gray-900">Preview subject: {previewText.subject}</p>
                <pre className="whitespace-pre-wrap font-sans text-gray-700">{previewText.body}</pre>
                {previewText.signatureHtml && (
                  <div className="pt-2 border-t border-gray-200">
                    <div className="text-[10px] font-semibold text-gray-500 mb-1">Signature (auto-appended):</div>
                    <div className="bg-white rounded p-2 border border-gray-100" data-testid="compose-preview-signature" dangerouslySetInnerHTML={{ __html: previewText.signatureHtml }} />
                  </div>
                )}
              </div>
            )}

            {msg && (
              <div
                role="alert"
                data-testid={msg.kind === 'reauth' ? 'compose-reauth' : msg.kind === 'ok' ? 'compose-sent' : 'compose-error'}
                className={
                  msg.kind === 'ok'      ? 'text-xs rounded-lg px-3 py-2 border border-green-200 bg-green-50 text-green-800' :
                  msg.kind === 'reauth'  ? 'text-xs rounded-lg px-3 py-2 border border-amber-200 bg-amber-50 text-amber-900' :
                                           'text-xs rounded-lg px-3 py-2 border border-red-200 bg-red-50 text-red-700'
                }
              >
                {msg.text}
                {msg.kind === 'reauth' && (
                  <>
                    {' '}
                    <a href="/crm/settings" className="underline font-medium">Reconnect →</a>
                  </>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
              <button type="button" onClick={doPreview} disabled={pending || !subject || !body} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">
                {pending ? 'Working…' : 'Preview'}
              </button>
              <button
                type="button" onClick={doSend}
                disabled={pending || noAccounts || !toDisplay || !subject || !body || ownerDisconnected}
                className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
                data-testid="compose-send"
              >
                {pending ? 'Sending…' : previewText ? 'Send' : 'Preview & send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
