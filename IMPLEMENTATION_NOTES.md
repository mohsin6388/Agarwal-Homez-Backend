# PropAI CRM — Phases 1–7 Regression Audit

This archive combines the redesigned PropAI CRM frontend and backend with the original files/routes retained, plus the Phase 1–7 features previously added. The original accordion/dropdown sidebar is retained in this archive.

## Regression fixes applied in this audit

1. Qualified Leads: the Visit tab now requires a non-cancelled meeting booked by `whatsapp_ai`, rather than treating manual/email meetings as WhatsApp-AI visit leads.
2. Site Visits: the `upcoming` group now lists only `scheduled` / `rescheduled` visits and aligns with the count; selecting an explicit status filter returns to the `all` group so the status filter is effective.
3. Audience Builder: “Campaign banao”/post-save action navigates to `/outreach/whatsapp/new?audienceId=...`, which is the actual wizard route and supports audience preselection.
4. Follow Ups: email-sourced cards link to their email thread; the email conversations page loads the owner-scoped thread from the `threadId` query parameter. WhatsApp-sourced cards continue to deep-link into the selected WhatsApp conversation.
5. Removed duplicate `brochureUrl`, `ctaText`, and `ctaUrl` object keys from campaign snapshots.

## Static verification

- Backend JavaScript syntax: `node --check` passed for all 120 JavaScript files under `src/`.
- Backend local `require()` targets: 0 missing relative module references.
- Frontend parser: 63 JS/JSX/TS files parsed with TypeScript's parser; 0 syntax errors.
- Frontend relative imports: 0 missing local imports across 63 source files.
- Campaign variable resolver smoke checks: 6 assertions passed (name, fallback, budget range, static text, component shape).
- API route comparison: original backend route declarations (107) were all retained; 15 new route declarations added.
- Frontend route comparison: all 24 original route paths retained; 7 new route paths added.

## Not verified / required before production

- `npm run build` was not verified because `vite` was unavailable in this runtime; install frontend dependencies with `npm ci`, then run `npm run build`.
- No live MongoDB, Meta WhatsApp Cloud API, Cloudinary, Brevo, inbound email webhook, or Google Calendar end-to-end testing was performed.
- No automated test suite was present to exercise the whole app, and no authenticated browser/UI test was run.
- The backend email campaign worker intentionally refuses to send if `API_PUBLIC_URL` (or `PUBLIC_API_URL`) is not a public HTTPS URL, because a real unsubscribe link is mandatory.
- Before startup, back up MongoDB and run the relevant migrations in `agarwal-chatbot-backend/`:
  - `npm run migrate:lead-contact-indexes`
  - `npm run migrate:audience-indexes`
  - `npm run migrate:whatsapp-template-draft-indexes`
  - `npm run migrate:campaign-wizard-indexes`
  - `npm run migrate:phase6-7`
- Confirm `.env` credentials, Meta approved template names, Meta webhook subscription, Cloudinary upload credentials, Brevo sender authentication/inbound webhooks, `API_PUBLIC_URL`, and the reminder template configuration before live tests.

## Important note

Static checks prove syntax and local reference integrity, not that every feature works against production credentials/data. Run the staging checklist against a backed-up/test database and a small consent-confirmed audience before sending a real campaign.
