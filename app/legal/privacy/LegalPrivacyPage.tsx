'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import SiteHeader from '../../_landing/SiteHeader';
import SiteFooter from '../../_landing/SiteFooter';
import { PRIVACY_VERSION, PRIVACY_EFFECTIVE_DATE_LABEL } from '@/lib/legal/privacy';
import '../../landing.css';
import './privacy.css';

// ─── /legal/privacy — Privacy Policy ───────────────────────────────────
//
// Mirror of app/legal/terms/LegalTermsPage.tsx: a faithful port of the
// standalone privacy HTML (v1.0). The WORDS are the policy verbatim; only
// the WRAPPER is restyled onto the shared marketing chrome. Content lives
// as data (SECTIONS) so every clause renders through a {JS expression},
// keeping the legal text byte-faithful and the numbering mechanical.
//
// The internal amber reviewer note in the source HTML (an internal
// pre-launch checklist) is intentionally NOT ported — it is not customer
// content.
//
// Version + effective date come from lib/legal/privacy.ts — the same
// constants recorded (privacy_version) at signup + plan activation.

type Part =
  | string
  | { b: string }
  | { link: string; href: string };

type Clause = {
  n?: string;
  sub?: boolean;
  parts?: Part[];
  // A clause slot may instead render an info table (section 2).
  table?: { head: [string, string]; rows: Array<[string, string]> };
};

type Section = {
  id: string;
  num: string;
  title: string;
  toc: string;
  clauses: Clause[];
  callout?: string;  // plain-language callout (section 4)
};

const SUPPORT = { link: 'support@betternow.co.za', href: 'mailto:support@betternow.co.za' } as const;

const SECTIONS: Section[] = [
  {
    id: 's1', num: '1', title: 'Who We Are', toc: 'Who We Are',
    clauses: [
      { n: '1.1', parts: ['betternow is a "buy-now-pay-later" service that lets you pay a merchant for goods or services over two or three instalments. For the purposes of POPIA, betternow is the ', { b: 'Responsible Party' }, ' for the Personal Information described in this policy.'] },
      { n: '1.2', parts: ['In some instances we act as an ', { b: 'Operator' }, ', Processing Personal Information on behalf of a Merchant that uses our services. In those cases, that Merchant’s own privacy policy applies to your use of their services.'] },
      { n: '1.3', parts: ['We do not knowingly Process the Personal Information of minors (persons under 18), and our services are not offered to minors. We also do not Process special categories of Personal Information (such as information about health, race, religious beliefs, or biometric data). Please do not provide us with any such information.'] },
      { n: '1.4', parts: ['Our full details, and how to reach our Information Officer, are set out in section 12.'] },
    ],
  },
  {
    id: 's2', num: '2', title: 'Information We Collect', toc: 'Information We Collect',
    clauses: [
      { n: '2.1', parts: ['We collect the following categories of Personal Information, from you directly and from the sources described in clause 2.2:'] },
      { table: {
        head: ['Category', 'Examples'],
        rows: [
          ['Identity information', 'Your name, South African ID number, and date of birth.'],
          ['Contact information', 'Your cellphone number, email address and physical address.'],
          ['Financial information', 'Your card details (held securely by our payment processor, not by us), your payment-plan history, and information about your income and financial obligations.'],
          ['Credit information', 'Credit scores, credit-bureau records, default indicators and affordability information obtained from credit bureaux.'],
          ['Account information', 'Your login details, the plans you hold, and your communications with us.'],
          ['Technical information', 'Device, browser and usage information collected when you use our website or app, including through cookies (see section 9).'],
        ],
      } },
      { n: '2.2', parts: ['We collect Personal Information: (a) directly from you when you register, apply for or use a Payment Plan, or contact us; (b) from credit bureaux and other lawful sources when we assess your application and manage your account; (c) from the merchant you are transacting with; and (d) automatically when you use our website or app.'] },
      { n: '2.3', parts: ['Providing your Personal Information is voluntary; however, we may be unable to provide our services to you if you do not provide the information we reasonably require.'] },
      { n: '2.4', parts: ['Your South African ID number and card details are sensitive. We hold ID numbers in encrypted form, and your full card details are captured and stored by our PCI-compliant payment processor rather than by us.'] },
    ],
  },
  {
    id: 's3', num: '3', title: 'How We Use Your Information', toc: 'How We Use Your Information',
    clauses: [
      { n: '3.1', parts: ['We Process your Personal Information for the following purposes:'] },
      { n: '3.1.1', sub: true, parts: ['to verify your identity and the information you give us;'] },
      { n: '3.1.2', sub: true, parts: ['to assess your application, determine and review your spending limit, and decide whether to approve a Payment Plan;'] },
      { n: '3.1.3', sub: true, parts: ['to provide the Payment Services, manage your account, and collect the instalments you owe;'] },
      { n: '3.1.4', sub: true, parts: ['to communicate with you, including sending payment reminders, failed-payment notices and other service messages;'] },
      { n: '3.1.5', sub: true, parts: ['to detect, prevent and investigate fraud and other unlawful activity, and to comply with anti-money-laundering obligations;'] },
      { n: '3.1.6', sub: true, parts: ['to comply with our legal and regulatory obligations, including under the National Credit Act and the requirements of regulators, courts and tax authorities;'] },
      { n: '3.1.7', sub: true, parts: ['to develop, test and improve our products and services, and for research and statistical purposes using de-identified information;'] },
      { n: '3.1.8', sub: true, parts: ['to send you marketing where you have not opted out (see clause 3.3); and'] },
      { n: '3.1.9', sub: true, parts: ['for security, identification, and internal operational purposes such as staff training and monitoring.'] },
      { n: '3.2', parts: ['We rely on the following lawful bases under POPIA: your consent; the performance of our agreement with you; compliance with our legal obligations; and our (or a third party’s) legitimate interests.'] },
      { n: '3.3', parts: ['We may send you direct marketing about our products and services. You can opt out at any time using the unsubscribe mechanism in the message or by contacting us. Service messages relating to an active Payment Plan are not marketing and cannot be opted out of while the plan is active.'] },
      { n: '3.4', parts: ['We will only use your Personal Information for the purposes for which we collected it, unless we reasonably consider that we need to use it for another compatible purpose. If we need to use it for an unrelated purpose, we will notify you and explain the lawful basis for doing so, except where we are permitted or required by law to Process it without your knowledge or consent.'] },
    ],
  },
  {
    id: 's4', num: '4', title: 'Credit Checks and Automated Decisions', toc: 'Credit Checks & Automated Decisions',
    callout: 'In plain terms: to decide how much you can spend, our system automatically checks your credit record and affordability with a credit bureau. If you’re unhappy with an automated decision, you can ask us to look at it again.',
    clauses: [
      { n: '4.1', parts: ['When you register, and at any time while you have an account with us, we may request and obtain information about you from registered credit bureaux and other lawful sources to assess your application, verify your information, and set and review your spending limit.'] },
      { n: '4.2', parts: ['Our assessment uses paid credit-bureau products, which may include a credit score, default-indicator and warning information, and an affordability assessment based on your income and existing financial obligations. A credit bureau may keep a record of our enquiry. You have the right to contact the bureau, obtain your credit record, and challenge inaccurate information.'] },
      { n: '4.3', parts: ['We may transmit to registered credit bureaux information about your agreement with us, its termination, and any non-compliance by you with its terms.'] },
      { n: '4.4', parts: [{ b: 'Decisions about your application, spending limit and eligibility may be made by automated means — that is, by our systems without human intervention in the decision itself — based on the credit-bureau and affordability information described above. You have the right to request information about, and to make representations regarding, any such automated decision, and you may ask us to review it.' }] },
    ],
  },
  {
    id: 's5', num: '5', title: 'Sharing Your Information', toc: 'Sharing Your Information',
    clauses: [
      { n: '5.1', parts: ['We may share your Personal Information with:'] },
      { n: '5.1.1', sub: true, parts: [{ b: 'Service providers (Operators)' }, ' who Process information on our behalf under contract — including our payment processor, credit bureaux, cloud-hosting provider, and communication providers (SMS, email and push) — who are bound to Process it only as instructed and to protect it;'] },
      { n: '5.1.2', sub: true, parts: [{ b: 'Credit bureaux' }, ', as described in section 4;'] },
      { n: '5.1.3', sub: true, parts: [{ b: 'The merchant' }, ' you are transacting with, to the extent necessary to process and manage your Payment Plan;'] },
      { n: '5.1.4', sub: true, parts: [{ b: 'Regulators, courts, law-enforcement and other authorities' }, ', where required or permitted by law; and'] },
      { n: '5.1.5', sub: true, parts: [{ b: 'A successor or acquirer' }, ', if we cede, sell or transfer our business or the receivables under your Payment Plan.'] },
      { n: '5.2', parts: ['We do not sell your Personal Information.'] },
    ],
  },
  {
    id: 's6', num: '6', title: 'Storing Information Outside South Africa', toc: 'Storing Information Outside SA',
    clauses: [
      { n: '6.1', parts: ['Your Personal Information may be transferred to, stored on, or Processed on servers located outside South Africa, where some of our service providers or suppliers may Process it on our behalf.'] },
      { n: '6.2', parts: ['Where this happens, we do so in accordance with section 72 of POPIA. Your Personal Information will only be transferred to and stored in a country that has data-protection legislation that is equivalent to, or better than, that of South Africa, or with a service provider that is subject to an agreement requiring it to comply with data-protection requirements equivalent to, or better than, those applicable in South Africa. By accepting this policy and submitting your Personal Information to us, you consent to such transfer.'] },
    ],
  },
  {
    id: 's7', num: '7', title: 'How Long We Keep Your Information', toc: 'How Long We Keep It',
    clauses: [
      { n: '7.1', parts: ['We keep your Personal Information for as long as you have an account or an active Payment Plan with us, and thereafter for as long as we are required to by law (for example, financial, tax and credit-related record-keeping obligations) or as necessary to resolve disputes and enforce our agreements.'] },
      { n: '7.2', parts: ['When we no longer need your Personal Information and are no longer required to keep it, we will delete or de-identify it.'] },
    ],
  },
  {
    id: 's8', num: '8', title: 'How We Protect Your Information', toc: 'How We Protect It',
    clauses: [
      { n: '8.1', parts: ['We take appropriate, reasonable technical and organisational measures to protect your Personal Information against loss, unauthorised access and misuse. These include encryption of sensitive data such as ID numbers, access controls, and secure handling of card data by our PCI-compliant payment processor.'] },
      { n: '8.2', parts: ['If a security compromise affecting your Personal Information occurs, we will notify the Information Regulator and you, as required by POPIA.'] },
    ],
  },
  {
    id: 's9', num: '9', title: 'Cookies', toc: 'Cookies',
    clauses: [
      { n: '9.1', parts: ['Our website and app use cookies and similar technologies to operate the service, keep you signed in, remember your preferences, and understand how our service is used. Some cookies are essential for the service to function; others help us improve it.'] },
      { n: '9.2', parts: ['You can control non-essential cookies through your browser settings or any cookie-preference mechanism we provide. Disabling some cookies may affect how the service works.'] },
    ],
  },
  {
    id: 's10', num: '10', title: 'Your Rights', toc: 'Your Rights',
    clauses: [
      { n: '10.1', parts: ['Under POPIA you have the right to:'] },
      { n: '10.1.1', sub: true, parts: ['be told what Personal Information we hold about you and request a copy of it;'] },
      { n: '10.1.2', sub: true, parts: ['ask us to correct or update information that is inaccurate, irrelevant, excessive, out of date, incomplete, misleading or unlawfully obtained;'] },
      { n: '10.1.3', sub: true, parts: ['ask us to delete or destroy your Personal Information where we are no longer entitled to hold it;'] },
      { n: '10.1.4', sub: true, parts: ['object, on reasonable grounds, to our Processing of your Personal Information;'] },
      { n: '10.1.5', sub: true, parts: ['withdraw your consent where we rely on consent (this will not affect Processing that has already taken place, or Processing we are otherwise entitled or required to do); and'] },
      { n: '10.1.6', sub: true, parts: ['lodge a complaint with the Information Regulator.'] },
      { n: '10.2', parts: ['Requests for access to information are dealt with in terms of the Promotion of Access to Information Act 2 of 2000 (', { b: 'PAIA' }, ') and our PAIA Manual, which is available on request or on our website. We may charge a reasonable prescribed fee for access.'] },
      { n: '10.3', parts: ['To exercise any of these rights, contact us using the details in section 12. We will try to respond to all legitimate requests within one month; if your request is particularly complex or you have made several requests, it may take longer, in which case we will notify you and keep you updated. We may need to confirm your identity before acting on a request, as a security measure to ensure information is not disclosed to anyone who has no right to receive it.'] },
      { n: '10.4', parts: ['If you are not satisfied with how we handle your request, you may complain to the Information Regulator (see section 12); we would, however, appreciate the chance to address your concerns first.'] },
    ],
  },
  {
    id: 's11', num: '11', title: 'Changes to This Policy', toc: 'Changes to This Policy',
    clauses: [
      { n: '11.1', parts: ['We may update this Privacy Policy from time to time. The current version, its version number and its effective date will always be shown at the top of this page. Where a change is material, we will take reasonable steps to bring it to your attention.'] },
    ],
  },
  {
    id: 's12', num: '12', title: 'How to Contact Us', toc: 'How to Contact Us',
    clauses: [
      { n: '12.1', parts: [{ b: 'Responsible Party:' }, ' BETTERNOW (PTY) LTD, registration number 2026/420968/07.'] },
      // Identified by ROLE and contact route, not by person (v1.1). The
      // previous wording carried an unfilled "[INSERT NAME / TITLE]"
      // placeholder. Naming a route rather than an individual also means the
      // clause does not go stale when the role changes hands, and it invents
      // no fact we cannot stand behind.
      { n: '12.2', parts: [{ b: 'Information Officer:' }, ' our Information Officer can be reached at ', SUPPORT, '. Please mark your message for the attention of the Information Officer so that it is routed correctly.'] },
      { n: '12.3', parts: [{ b: 'General privacy queries and requests:' }, ' ', SUPPORT, '.'] },
      { n: '12.4', parts: [{ b: 'Information Regulator (South Africa):' }, ' you may lodge a complaint with the Information Regulator. Details are available at the Regulator’s website, inforegulator.org.za.'] },
    ],
  },
];

function renderPart(part: Part, i: number) {
  if (typeof part === 'string') return <span key={i}>{part}</span>;
  if ('b' in part) return <strong key={i}>{part.b}</strong>;
  return <a key={i} href={part.href}>{part.link}</a>;
}

export default function LegalPrivacyPage() {
  // Active-section highlighting in the side nav — same behaviour as the
  // terms page (ported from the source document's inline script).
  useEffect(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.lp-privacy-toc a'),
    );
    const map = new Map<string, HTMLAnchorElement>();
    links.forEach((a) => {
      const id = a.getAttribute('href')?.slice(1);
      if (id) { const el = document.getElementById(id); if (el) map.set(id, a); }
    });
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            links.forEach((l) => l.classList.remove('active'));
            map.get(e.target.id)?.classList.add('active');
          }
        });
      },
      { rootMargin: '-100px 0px -70% 0px', threshold: 0 },
    );
    map.forEach((_a, id) => { const el = document.getElementById(id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, []);

  return (
    <div className="lp-root">
      <SiteHeader />

      <div className="lp-privacy-wrap">
        <nav className="lp-privacy-toc" aria-label="Section navigation">
          <h2>On this page</h2>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.toc}</a></li>
            ))}
          </ol>
        </nav>

        <main className="lp-privacy-main">
          <h1 className="lp-privacy-title">Privacy Policy</h1>
          <p className="lp-privacy-sub">BETTERNOW (PTY) LTD · Registration number 2026/420968/07</p>
          <p className="lp-privacy-sub">
            Version {PRIVACY_VERSION} · Last updated {PRIVACY_EFFECTIVE_DATE_LABEL}
          </p>

          <p className="lp-privacy-intro">
            Your privacy matters to us. This Privacy Policy explains what Personal
            Information betternow collects, how and why we use it, who we share it with,
            and the rights you have. It should be read together with our{' '}
            <Link href="/legal/terms">Customer Terms and Conditions</Link>. We Process your
            Personal Information in accordance with the Protection of Personal Information
            Act 4 of 2013 (<strong>POPIA</strong>).
          </p>
          <p className="lp-privacy-intro">
            In this policy, <strong>{'"Personal Information"'}</strong>,{' '}
            <strong>{'"Process"'}</strong> and related terms have the meanings given to them
            in POPIA; <strong>{'"we" / "us" / "our" / "betternow"'}</strong> means BETTERNOW
            (PTY) LTD; and <strong>{'"you" / "your"'}</strong> means the person whose Personal
            Information we Process.
          </p>

          {SECTIONS.map((s) => (
            <section key={s.id}>
              <h2 className="lp-privacy-section" id={s.id}>
                <span className="lp-privacy-num">{s.num}</span>{s.title}
              </h2>
              {s.clauses.map((c, ci) =>
                c.table ? (
                  <div key={ci} className="lp-privacy-table-wrap">
                    <table className="lp-privacy-table">
                      <thead>
                        <tr><th>{c.table.head[0]}</th><th>{c.table.head[1]}</th></tr>
                      </thead>
                      <tbody>
                        {c.table.rows.map((r, ri) => (
                          <tr key={ri}><td>{r[0]}</td><td>{r[1]}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p key={ci} className={`lp-privacy-clause${c.sub ? ' sub' : ''}`}>
                    {c.n && <span className="lp-privacy-cn">{c.n}</span>}
                    {c.parts?.map(renderPart)}
                  </p>
                ),
              )}
              {s.callout && (
                <div className="lp-privacy-callout">
                  <b>In plain terms:</b>{s.callout.replace(/^In plain terms:/, '')}
                </div>
              )}
            </section>
          ))}

          <p className="lp-privacy-foot">
            Questions about your privacy? Email{' '}
            <a href="mailto:support@betternow.co.za">support@betternow.co.za</a>.{' '}
            <a className="lp-privacy-backtop" href="#top">Back to top ↑</a>
          </p>
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}
