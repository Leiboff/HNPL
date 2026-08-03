'use client';

import { useEffect } from 'react';
import SiteHeader from '../../_landing/SiteHeader';
import SiteFooter from '../../_landing/SiteFooter';
import { TERMS_VERSION, TERMS_EFFECTIVE_DATE_LABEL } from '@/lib/legal/terms';
import '../../landing.css';
import './terms.css';

// ─── /legal/terms — Customer Terms & Conditions ────────────────────────
//
// A faithful port of the standalone terms HTML (v1.0). The WORDS are the
// legal text verbatim; only the WRAPPER is restyled — shared marketing
// chrome (SiteHeader / SiteFooter, .lp-root tokens) instead of the
// source file's inline CSS. See terms.css for the restyle.
//
// Content lives as data (SECTIONS) rather than hand-written JSX so every
// clause renders through a {JS expression} — this keeps the legal text
// byte-faithful (no react/no-unescaped-entities escaping of the many
// quotes/apostrophes) and keeps the numbering + structure mechanical.
//
// The version + effective date come from lib/legal/terms.ts — the same
// constants stamped on the profile at signup and the plan at activation,
// so what a customer READS and what we RECORD can never drift.

// A run of inline content within a clause: a plain string, a bold
// fragment, or a link.
type Part =
  | string
  | { b: string }
  | { link: string; href: string };

type Clause = {
  n?: string;        // clause number, e.g. '1.1'; omitted for lead-ins
  sub?: boolean;     // deeper indent for x.y.z sub-clauses
  parts: Part[];
};

type Section = {
  id: string;        // anchor id, e.g. 's1'
  num: string;       // display number, e.g. '1'
  title: string;     // full heading
  toc: string;       // short label for the side nav
  clauses: Clause[];
  callout?: string;  // plain-language callout (section 7 fee summary)
};

const SUPPORT = { link: 'support@betternow.co.za', href: 'mailto:support@betternow.co.za' } as const;

const SECTIONS: Section[] = [
  {
    id: 's1', num: '1', title: 'Definitions', toc: 'Definitions',
    clauses: [
      { parts: ['In this Agreement, unless the context requires otherwise:'] },
      { n: '1.1', sub: true, parts: [{ b: '"Agreement"' }, ' means this entire agreement, together with the Payment Plan applicable to a particular purchase.'] },
      { n: '1.2', sub: true, parts: [{ b: '"Business Day"' }, ' means any day other than a Saturday, Sunday or official public holiday in South Africa.'] },
      { n: '1.3', sub: true, parts: [{ b: '"Card"' }, ' means a valid credit or debit card issued by a South African bank in your name.'] },
      { n: '1.4', sub: true, parts: [{ b: '"Customer" / "you" / "your"' }, ' means the person who uses the betternow Platform to purchase Goods from a Merchant over a Payment Plan.'] },
      { n: '1.5', sub: true, parts: [{ b: '"Default Fee"' }, ' means a fee of R115.00 (including VAT) charged for each week that an Instalment Payment (or any part of it) remains unpaid after its due date, charged for a maximum of three (3) times per Payment Plan, and subject to the cap in clause 7.'] },
      { n: '1.6', sub: true, parts: [{ b: '"Goods"' }, ' means the goods or services that you are purchasing from the Merchant.'] },
      { n: '1.7', sub: true, parts: [{ b: '"Instalment Payment"' }, ' means a periodic payment set out in your Payment Plan.'] },
      { n: '1.8', sub: true, parts: [{ b: '"Merchant"' }, ' means the merchant that has integrated with the betternow Platform in order to offer the Payment Services, and from whom you are purchasing the Goods.'] },
      { n: '1.9', sub: true, parts: [{ b: '"Merchant Site"' }, ' means the e-commerce site, premises or point of sale of the Merchant.'] },
      { n: '1.10', sub: true, parts: [{ b: '"NCA"' }, ' means the National Credit Act 34 of 2005, together with its regulations, as amended from time to time.'] },
      { n: '1.11', sub: true, parts: [{ b: '"betternow" / "we" / "us" / "our"' }, ' means BETTERNOW (PTY) LTD, registration number 2026/420968/07, a company incorporated under the laws of South Africa.'] },
      { n: '1.12', sub: true, parts: [{ b: '"Payment Plan"' }, ' means the Pay-in-2 or Pay-in-3 instalment arrangement you select, being: (a) Pay-in-2 — the Purchase Price paid in two equal instalments, the first due upfront and the second on your next selected payday; or (b) Pay-in-3 — the Purchase Price paid in three equal instalments, the first due upfront and the remaining two on your next two selected paydays.'] },
      { n: '1.13', sub: true, parts: [{ b: '"Payment Services" / "Platform"' }, ' means the betternow technology platform and the payment-plan service we provide through it.'] },
      { n: '1.14', sub: true, parts: [{ b: '"POPIA"' }, ' means the Protection of Personal Information Act 4 of 2013.'] },
      { n: '1.15', sub: true, parts: [{ b: '"Personal Information"' }, ' has the meaning given to it in POPIA, and "Process", "Processing" and "Processed" have corresponding meanings.'] },
      { n: '1.16', sub: true, parts: [{ b: '"Privacy Policy"' }, ' means our privacy policy as published on our website, as amended from time to time.'] },
      { n: '1.17', sub: true, parts: [{ b: '"Purchase Price"' }, ' means the full amount (inclusive of VAT) payable for the Goods, including any delivery or other costs included in the price.'] },
    ],
  },
  {
    id: 's2', num: '2', title: 'The Payment Plan Service', toc: 'The Payment Plan Service',
    clauses: [
      { n: '2.1', parts: ['When we accept your request for a Payment Plan, we pay the Merchant the Purchase Price for the Goods on your behalf, and you agree to repay us in accordance with your Payment Plan, subject to this Agreement.'] },
      { n: '2.2', parts: ['The Goods you purchase are governed by the Merchant’s own terms and policies. Your agreement in respect of the Goods is with the Merchant. Your agreement in respect of the Payment Plan is with us.'] },
      { n: '2.3', parts: ['Once you have entered into a Payment Plan, it cannot be amended or cancelled except as set out in this Agreement or as required by law.'] },
      { n: '2.4', parts: ['For Pay-in-2 and Pay-in-3, the timing of your instalments is based on the payday you select. If you set up your plan five or more days before your selected payday in a given month, the next instalment falls on that month’s payday; if you set it up within five days of your payday, the next instalment falls on the following month’s payday.'] },
    ],
  },
  {
    id: 's3', num: '3', title: 'Our Obligations and Discretion', toc: 'Our Obligations & Discretion',
    clauses: [
      { n: '3.1', parts: ['If your request for a Payment Plan is approved, we will pay the Merchant the Purchase Price on your behalf.'] },
      { n: '3.2', parts: ['Where you have entered into a Payment Plan, we will continue to fulfil our obligations to you unless the Payment Plan is terminated in accordance with this Agreement.'] },
      { n: '3.3', parts: ['We do not guarantee approval and may decline any request for a Payment Plan in our reasonable discretion, even if you have used and repaid Payment Plans before. Our discretion will be exercised reasonably.'] },
      { n: '3.4', parts: ['We may, on reasonable assessment and acting reasonably, set, review and amend the amount you are able to spend across Payment Plans at any time.'] },
      { n: '3.5', parts: [{ b: 'If you default on any Payment Plan, you will be frozen from taking out further Payment Plans until the defaulted amount (including any Default Fees) has been settled in full.' }] },
    ],
  },
  {
    id: 's4', num: '4', title: 'Your Obligations and Undertakings', toc: 'Your Obligations & Undertakings',
    clauses: [
      { n: '4.1', parts: ['In return for us paying the Merchant the Purchase Price on your behalf, you agree to pay us in accordance with your Payment Plan, together with any Default Fees that become payable under clause 7.'] },
      { n: '4.2', parts: ['You warrant that all information you provide to us is true, complete, accurate and current, and that you will tell us immediately if it changes.'] },
      { n: '4.3', parts: ['You confirm that you:'] },
      { n: '4.3.1', sub: true, parts: ['are 18 years of age or older;'] },
      { n: '4.3.2', sub: true, parts: ['lawfully reside in South Africa on a permanent basis;'] },
      { n: '4.3.3', sub: true, parts: ['are permanently employed or self-employed in South Africa;'] },
      { n: '4.3.4', sub: true, parts: ['are not currently over-indebted or in financial difficulty;'] },
      { n: '4.3.5', sub: true, parts: ['have not been declared mentally unfit by a court;'] },
      { n: '4.3.6', sub: true, parts: ['are not under administration, debt review, or provisional or final sequestration; and'] },
      { n: '4.3.7', sub: true, parts: ['hold a valid debit or credit card issued by a South African bank in your name.'] },
      { n: '4.4', parts: [{ b: 'You unconditionally and irrevocably authorise us to debit your Card in accordance with your Payment Plan, including any Default Fees, and to store your Card details securely with our payment processor so that scheduled instalments can be collected automatically on their due dates without you re-entering your Card details.' }] },
      { n: '4.5', parts: ['You agree to ensure sufficient funds are available in your Card account to cover each Instalment Payment when due, or to pay any Instalment Payment in full before its due date.'] },
      { n: '4.6', parts: ['You agree to pay all amounts due under your Payment Plan regardless of any dispute or issue with the Goods or with the Merchant, and regardless of whether you currently have the Goods in your possession, including where Goods were ordered as a result of any unauthorised or fraudulent use of your account. You may not withhold, set off or deduct any Instalment Payment for any such reason.'] },
      { n: '4.7', parts: ['You are responsible for any fees your own bank may charge in connection with payments made using your Card.'] },
      { n: '4.8', parts: ['You agree to keep your account details and password confidential and are responsible for any activity on your account, including unauthorised or fraudulent use. You agree to contact us immediately if you suspect unauthorised or fraudulent use of your account, and you indemnify us against losses arising from any failure to do so.'] },
      { n: '4.9', parts: ['If there is, or we reasonably suspect there may be, unauthorised or fraudulent activity on your account, or if we are required to do so by law, we may suspend your account without notice, and you indemnify us against any resulting losses.'] },
      { n: '4.10', parts: ['You agree that each Payment Plan is a new transaction, that your use of the betternow Platform and the Payment Services is at our discretion, and that there is no guarantee that the Platform or the Payment Services will be available for any purchase.'] },
      { n: '4.11', parts: ['You agree not to apply any set-off or deduction against any Instalment Payment for any reason, including any dispute with the Merchant or in relation to the Goods, or where Goods were ordered as a result of any unauthorised or fraudulent use of your account.'] },
    ],
  },
  {
    id: 's5', num: '5', title: 'Merchants', toc: 'Merchants',
    clauses: [
      { n: '5.1', parts: ['We do not guarantee and are not responsible for the suitability, quality, delivery or availability of any Goods you purchase from a Merchant, all of which are the responsibility of the Merchant.'] },
      { n: '5.2', parts: ['Any dispute about the Goods — including quality, non-delivery, or a request to return or refund — must be resolved directly with the Merchant.'] },
      { n: '5.3', parts: ['A dispute or complaint with a Merchant does not entitle you to withhold, reduce or set off any payment due to us under your Payment Plan.'] },
      { n: '5.4', parts: ['We will not be liable to you if a Merchant refuses to accept our Payment Services for any Goods. You will have no right to claim anything from us, to institute any counterclaim against us, or to apply any set-off against us, on this or any other basis.'] },
    ],
  },
  {
    id: 's6', num: '6', title: 'Interest and Fees', toc: 'Interest & Fees',
    clauses: [
      { n: '6.1', parts: [{ b: 'No fees or interest are charged on your Payment Plan, provided all Instalment Payments are made in accordance with the Payment Plan.' }, ' It costs nothing to open or use a betternow account.'] },
      { n: '6.2', parts: ['Default Fees will be charged in accordance with clause 7 only if an Instalment Payment is not paid in full on its due date.'] },
    ],
  },
  {
    id: 's7', num: '7', title: 'Missed Payments and Default Fees', toc: 'Missed Payments & Default Fees',
    callout: 'In short: if you miss a payment, we try again. If it still isn’t paid, a R115 fee applies, and another R115 for each week it stays unpaid — up to 3 fees in total, and never more than 25% of your purchase. Pay on time and you’ll never pay a cent in fees.',
    clauses: [
      { n: '7.1', parts: ['Your Payment Plan sets out the due date for each Instalment Payment.'] },
      { n: '7.2', parts: ['If we do not receive an Instalment Payment in full on its due date, we will re-attempt collection. If the payment remains unpaid, a ', { b: 'Default Fee of R115.00 (including VAT)' }, ' will be charged, and a further Default Fee of R115.00 (including VAT) may be charged for each subsequent week that any amount remains overdue, until the earlier of: (a) your overdue balance (including Default Fees) being paid in full; or (b) a maximum of ', { b: 'three (3) Default Fees' }, ' having been charged on that Payment Plan.'] },
      { n: '7.3', parts: [{ b: 'The total Default Fees charged on a Payment Plan are capped at the lower of: (a) R345.00 (including VAT), being three Default Fees; or (b) 25% of the Purchase Price (including VAT) of that Payment Plan.' }] },
      { n: '7.4', parts: ['If we are unable to collect an Instalment Payment from your Card on its due date, you irrevocably authorise us to re-attempt collection of the overdue Instalment Payment (including any Default Fees) from your Card on any later date until it is recovered or the Payment Plan reaches the maximum number of Default Fees.'] },
      { n: '7.5', parts: ['We may, in our absolute discretion, waive or defer any Default Fee. Any waiver or deferral of a Default Fee (whether temporary or permanent) does not imply a waiver of any other amount due to us under a Payment Plan, and we reserve all rights to demand such other amounts.'] },
    ],
  },
  {
    id: 's8', num: '8', title: 'Overdue Amounts and the NCA', toc: 'Overdue Amounts & the NCA',
    clauses: [
      { n: '8.1', parts: ['betternow provides interest-free instalment arrangements. A Payment Plan is not a credit agreement under the NCA while it is performing. If an amount remains overdue such that the arrangement is deemed an incidental credit agreement under the NCA, the provisions of the NCA applicable to incidental credit agreements will apply.'] },
      { n: '8.2', parts: ['To the extent permitted by law, you may be liable for reasonable default administration charges and collection costs actually incurred in recovering an overdue amount.'] },
      { n: '8.3', parts: ['We may approach a court for judgment in respect of any amount you owe us under this Agreement. If we do, a certificate signed by any one of our managers (whose appointment and authority need not be proved) stating the amount you owe us and any applicable rate, shall be sufficient proof of the amount of your indebtedness and shall be deemed correct unless you prove otherwise.'] },
      { n: '8.4', parts: ['The address you provided when registering is the address at which legal documents may be served on you. Where permitted, we may serve documents electronically at the email address we have on record. To change your address, email address or cellphone number, you must notify us, and the change takes effect seven (7) Business Days after we receive the notice.'] },
      { n: '8.5', parts: ['If you have a query or complaint, please contact us at ', SUPPORT, '. If your Payment Plan becomes an incidental credit agreement, you may lodge a complaint with the National Credit Regulator or apply to the National Consumer Tribunal.'] },
    ],
  },
  {
    id: 's9', num: '9', title: 'Refund Arrangements', toc: 'Refund Arrangements',
    clauses: [
      { n: '9.1', parts: ['Any full or partial return of the Goods is subject to the Merchant’s returns policy and applicable law and must be settled with that Merchant.'] },
      { n: '9.2', parts: ['We will only amend a Payment Plan and process a refund once the Merchant has requested us in writing to do so. Any refund amount will be applied to your outstanding instalments, and any amount refundable to you will be paid to your nominated bank account.'] },
      { n: '9.3', parts: ['If a Merchant refunds you directly (in cash, voucher or otherwise), you remain responsible for paying your Payment Plan in full, notwithstanding that refund.'] },
    ],
  },
  {
    id: 's10', num: '10', title: 'Personal Information, Credit Checks and Automated Decisions', toc: 'Personal Information & Credit Checks',
    clauses: [
      { n: '10.1', parts: ['Your privacy matters to us. We take reasonable steps to keep any information, including Personal Information, that you provide or that we collect from you or third parties, secure, and we Process it in accordance with POPIA and our Privacy Policy.'] },
      { n: '10.2', parts: ['You agree to give us honest, accurate and current Personal Information about yourself, and to maintain and update it when necessary. You indemnify us against any losses or harm we may incur as a result of our reliance on inaccurate information you provide.'] },
      { n: '10.3', parts: ['You agree and consent that, when you register and at any time while this Agreement is in force, we may request and obtain information about you from registered credit bureaux and from any other lawful source in order to assess your application, verify your information, and determine and review the amount you may spend.'] },
      { n: '10.4', parts: ['You acknowledge and consent that our assessment uses paid credit-bureau products, which may include a credit score, default-indicator and warning information, and an affordability assessment based on your income and existing financial obligations. You acknowledge that a credit bureau may keep a record of our enquiry and may provide a credit profile and a credit score on your creditworthiness. You have the right to contact the bureau, to have your credit record disclosed, and to correct any inaccurate information.'] },
      { n: '10.5', parts: [{ b: 'You acknowledge and expressly consent that decisions about your application, your spending limit and your eligibility for the Payment Services may be made by automated means, without human intervention in the decision itself, based on the credit-bureau and affordability information described above. You have the right to request information about, and to make representations regarding, any such automated decision.' }] },
      { n: '10.6', parts: ['You agree and consent that we may transmit to registered credit bureaux information concerning this Agreement and its termination, and any non-compliance by you with the terms of this Agreement.'] },
      { n: '10.7', parts: ['You acknowledge and expressly consent that we may Process your Personal Information for the following purposes, amongst others:'] },
      { n: '10.7.1', sub: true, parts: ['to verify the information you provide and to make any enquiries we consider necessary from any lawful source;'] },
      { n: '10.7.2', sub: true, parts: ['to conclude this Agreement, to provide the Payment Services to you, and to comply with your instructions;'] },
      { n: '10.7.3', sub: true, parts: ['to assess your application, determine and review your spending limit, and manage and maintain your account and our relationship with you;'] },
      { n: '10.7.4', sub: true, parts: ['to detect, prevent and report fraud and criminal activity, to identify the proceeds of unlawful activity, to combat money laundering, and to assist law-enforcement agencies;'] },
      { n: '10.7.5', sub: true, parts: ['to comply with any obligation imposed on us by law, including statutory and regulatory record-keeping requirements, and requests for information from regulators, courts or bodies lawfully entitled to it (for example, tax authorities);'] },
      { n: '10.7.6', sub: true, parts: ['to comply with requests for access to information, including in terms of the Promotion of Access to Information Act 2 of 2000;'] },
      { n: '10.7.7', sub: true, parts: ['to enforce and collect payments when you are in default or breach of this Agreement, and to disclose and obtain information from credit bureaux;'] },
      { n: '10.7.8', sub: true, parts: ['to assess and respond to your queries and complaints;'] },
      { n: '10.7.9', sub: true, parts: ['to develop, test and improve our products and services, and for historical, statistical and research purposes;'] },
      { n: '10.7.10', sub: true, parts: ['to communicate with you and deliver notices and documents to you; and'] },
      { n: '10.7.11', sub: true, parts: ['for security, identification, staff training and monitoring, and other internal operational purposes.'] },
      { n: '10.8', parts: ['You agree and consent that we may share your Personal Information with third parties, including our service providers and business partners, where it is necessary to provide the Payment Services or where it is in our or their legitimate interests to do so, and, where permitted by law, for direct-marketing purposes.'] },
      { n: '10.9', parts: ['We may Process your Personal Information outside the borders of South Africa, in accordance with the safeguards and requirements of applicable law. These safeguards may include transferring and storing your Personal Information in a country that has data-protection legislation that is equivalent to, or better than, that of South Africa, or engaging a service provider that is subject to an agreement requiring it to comply with data-protection requirements equivalent to, or better than, those applicable in South Africa. Our cloud infrastructure and certain service providers may store and Process your Personal Information in data centres located outside South Africa, including in the European Union.'] },
      { n: '10.10', parts: ['We may Process your information using automated means to make decisions about you or any application you make, as described in clause 10.5. We may use de-personalised information for product development and research.'] },
      { n: '10.11', parts: ['You acknowledge that any Personal Information you supply is provided voluntarily, and that we may be unable to provide the Payment Services or comply with our obligations if you do not provide the Personal Information we request.'] },
      { n: '10.12', parts: ['By submitting Personal Information to us in any form, you provide your unconditional, specific and voluntary consent to our Processing and storage of that Personal Information in the manner set out in this clause 10. In the absence of a written objection from you, this consent continues indefinitely or for the period otherwise required by law.'] },
      { n: '10.13', parts: ['You have the right to access the Personal Information we hold about you, on written request and within a reasonable time. You may also request us to delete your Personal Information where we are no longer authorised to Process it; if you do, we may freeze or suspend your account and stop sending you marketing.'] },
      { n: '10.14', parts: ['If you believe we have Processed your Personal Information unlawfully, you agree to first attempt to resolve the matter with us. If you remain dissatisfied, you have the right to lodge a complaint with the Information Regulator.'] },
    ],
  },
  {
    id: 's11', num: '11', title: 'Communications and Marketing', toc: 'Communications & Marketing',
    clauses: [
      { n: '11.1', parts: ['To operate your Payment Plan we will send you service communications by SMS, push notification, email or other channels you have provided — including payment reminders, failed-payment notices and default notices. These are not marketing and you cannot opt out of them while you have an active Payment Plan.'] },
      { n: '11.2', parts: ['We may send you marketing about our products and services. You may opt out of marketing at any time using the unsubscribe mechanism provided.'] },
    ],
  },
  {
    id: 's12', num: '12', title: 'Intellectual Property', toc: 'Intellectual Property',
    clauses: [
      { n: '12.1', parts: ['All intellectual property in the betternow Platform, including its content, images, logos and graphics, belongs to us. You must obtain our written permission before using any of it.'] },
    ],
  },
  {
    id: 's13', num: '13', title: 'Cession and Assignment', toc: 'Cession & Assignment',
    clauses: [
      { n: '13.1', parts: ['You may not cede, delegate, assign or transfer any of your rights or obligations under this Agreement or your Payment Plan without our consent, which we may withhold in our discretion.'] },
      { n: '13.2', parts: ['We may cede, delegate or assign our rights and obligations under this Agreement or your Payment Plan to a third party without your consent.'] },
    ],
  },
  {
    id: 's14', num: '14', title: 'Limitation of Liability', toc: 'Limitation of Liability',
    clauses: [
      { n: '14.1', parts: ['We will not be liable for any failure or delay caused by events outside our reasonable control, including failures of computer systems or power, industrial action, civil unrest or war.'] },
      { n: '14.2', parts: ['To the extent permitted by law, and provided we have not acted fraudulently or with gross negligence, we will not be liable for any loss or damage arising from your use of the Payment Services.'] },
      { n: '14.3', parts: ['When you use our website or electronic channels you do so at your own risk. We do not warrant that they will be uninterrupted, error-free or free of harmful components, or that all information is always accurate, complete or current. You indemnify us accordingly.'] },
      { n: '14.4', parts: ['We disclaim any liability arising from your failure to provide a correct email address or contact details when registering.'] },
    ],
  },
  {
    id: 's15', num: '15', title: 'General', toc: 'General',
    clauses: [
      { n: '15.1', parts: ['Nothing in this Agreement creates a partnership, joint venture, agency, trust or employment relationship between us.'] },
      { n: '15.2', parts: ['No failure or delay in exercising a right under this Agreement is a waiver of it, and no single or partial exercise prevents any further exercise of that or any other right.'] },
      { n: '15.3', parts: ['This Agreement constitutes the entire agreement between us in relation to a specific purchase of Goods and the relevant Payment Plan. Each new purchase of Goods by way of a Payment Plan forms a separate Agreement on these terms.'] },
      { n: '15.4', parts: ['If any provision of this Agreement is found to be invalid, illegal or unenforceable, it will be severed and the remaining provisions will continue in full force and effect.'] },
      { n: '15.5', parts: ['This Agreement is governed by the laws of South Africa, and the parties submit to the non-exclusive jurisdiction of the South African courts.'] },
      { n: '15.6', parts: ['We may delay enforcing our rights under this Agreement without losing them, and our inability to enforce any term will not affect any other term.'] },
      { n: '15.7', parts: ['If you wish to receive copies of documents relating to your account, you must tell us how you want them delivered (provided we are able to deliver them that way). In certain instances we may charge a reasonable fee for such copies.'] },
      { n: '15.8', parts: ['Each undertaking and clause in this Agreement is capable of independent enforcement, so that a court or tribunal may enforce the remainder of this Agreement even if it finds any particular undertaking, portion or clause to be invalid.'] },
    ],
  },
];

function renderPart(part: Part, i: number) {
  if (typeof part === 'string') return <span key={i}>{part}</span>;
  if ('b' in part) return <strong key={i}>{part.b}</strong>;
  return <a key={i} href={part.href}>{part.link}</a>;
}

export default function LegalTermsPage() {
  // Active-section highlighting in the side nav — same behaviour as the
  // source document's inline script, ported to an effect.
  useEffect(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.lp-terms-toc a'),
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

      <div className="lp-terms-wrap">
        <nav className="lp-terms-toc" aria-label="Section navigation">
          <h2>On this page</h2>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.toc}</a></li>
            ))}
          </ol>
        </nav>

        <main className="lp-terms-main">
          <h1 className="lp-terms-title">Customer Terms and Conditions</h1>
          <p className="lp-terms-sub">BETTERNOW (PTY) LTD · Registration number 2026/420968/07</p>
          <p className="lp-terms-sub">
            Version {TERMS_VERSION} · Last updated {TERMS_EFFECTIVE_DATE_LABEL}
          </p>

          <p className="lp-terms-intro">
            Thank you for choosing betternow. This agreement sets out the terms and
            conditions on which we provide our Payment Services, allowing you to pay a
            Merchant for Goods over two or three instalments. Please read it carefully and
            pay particular attention to the terms in <strong>bold</strong>.
          </p>
          <p className="lp-terms-intro">
            By ticking &ldquo;I agree&rdquo; (or the equivalent) when you create an account
            or set up a payment plan, you agree to be bound by these terms and conditions
            and by our Privacy Policy. These terms may change from time to time; if they do,
            you will be asked to accept the updated terms when you next set up a plan.
          </p>

          {SECTIONS.map((s) => (
            <section key={s.id}>
              <h2 className="lp-terms-section" id={s.id}>
                <span className="lp-terms-num">{s.num}</span>{s.title}
              </h2>
              {s.clauses.map((c, ci) => (
                <p key={ci} className={`lp-terms-clause${c.sub ? ' sub' : ''}`}>
                  {c.n && <span className="lp-terms-cn">{c.n}</span>}
                  {c.parts.map(renderPart)}
                </p>
              ))}
              {s.callout && (
                <div className="lp-terms-callout">
                  <b>In short:</b>{s.callout.replace(/^In short:/, '')}
                </div>
              )}
            </section>
          ))}

          <p className="lp-terms-foot">
            Questions about these terms? Email us at{' '}
            <a href="mailto:support@betternow.co.za">support@betternow.co.za</a>.{' '}
            <a className="lp-terms-backtop" href="#top">Back to top ↑</a>
          </p>
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}
