# PropAI CRM — implementation and production setup notes

## Changes in this delivery

- Reworked the login layout with an emerald, ivory and gold property-brand theme and included the property background asset in the frontend's `public/images` folder.
- Simplified the CRM header/sidebar branding and tightened copy in the Upload Data and Qualified Leads screens.
- Added import modes for WhatsApp-only, Email-only and both channels. Import still only saves contacts; it does not send messages.
- Removed manual age, occupation and lead-budget inputs. Lead temperature and score are surfaced in the contact list and the AI qualification workflow.
- Filtered WhatsApp conversations to actual inbound customer messages or successfully sent outbound messages. Empty imported-contact conversation shells are hidden. First template sends are logged with the actual template body when its content is known.
- Removed campaign start-time/daily schedule controls; campaigns created from the current UI are queued to start immediately, still with the worker's message pacing and provider limits. The launch form currently caps one campaign at 5,000 contacts.
- Added image URL storage for Email templates and Cloudinary upload API support for template/property images. The upload endpoint accepts a single image up to 25 MB; property uploads accept images up to 25 MB each in the new upload flow. WhatsApp's sample image for an IMAGE-header Meta template is capped at 5 MB before submission.
- Added WhatsApp template deletion through Meta's Graph API, with the matching local Cloudinary asset record cleared.
- Added configurable hot-lead alerts in Settings. Alerts are disabled until a destination phone number is saved; Hot only is the default. Optionally enable Hot or Warm.
- Raised default access token lifetime to 8 hours and refresh token lifetime to 90 days. Existing `.env` values override these defaults.

## Required environment setup

Copy `.env.example` to `.env` in the backend, then set real credentials. Never commit `.env` to source control.

- **MongoDB / auth:** set `MONGO_URI`, strong unique `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY`. Existing users may remain logged in until their old token expires; new sessions use the configured expiry.
- **Cloudinary uploads:** configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. The backend returns Cloudinary HTTPS URLs which are saved into property/template records.
- **Official WhatsApp Cloud API:** configure the `META_WHATSAPP_*` values already documented in `.env.example`, using a long-lived System User token and the correct Phone Number ID and WABA ID. Image-header template submission also needs `META_APP_ID` and Meta app upload permissions.
- **Lead alerts:** save the recipient number in **Settings → Alert your lead on your number** (international digits, e.g. `919876543210`). The default is Hot only. If Meta rejects free-text because the recipient's 24-hour service window is closed, create and approve an alert template in WhatsApp Manager and set `META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME` plus its language in `.env`. Its BODY should contain five text placeholders matching: lead name, phone, email, score, summary. A Meta-approved template and valid consent/opt-in are still required where applicable.
- **Email:** configure `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, and the relevant inbound webhook settings for sending/replies.
- **Frontend:** set `VITE_API_BASE_URL` to the deployed backend's `/api/` origin before building.
- **Cross-origin HTTPS deployment:** if frontend and backend are on different HTTPS origins, set `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`; set `CLIENT_URL` to the actual frontend origin. If you use a cookie domain, set `COOKIE_DOMAIN` only to a domain that should receive it. Confirm CORS credentials are enabled for that origin.

## Deployment checklist

1. Install frontend/backend dependencies from their lockfiles in your deployment environment.
2. Set all production secrets as environment variables; do not ship a local `.env`.
3. Confirm Cloudinary, Meta, Brevo, MongoDB and frontend API origin are valid.
4. Start the API and confirm `GET /api/health` returns success.
5. Test with an internal opt-in test contact first: import only, send one approved WhatsApp template, verify inbound webhook/replies, send one email, upload a property image, then test a hot-lead alert.
6. Check Meta template approval status, WhatsApp opt-in/quality policy, email consent/unsubscribe process and local privacy requirements before any bulk campaign.

## Verification limits for this source bundle

Backend JavaScript syntax checks passed during preparation. A frontend production build could not be run in this environment because frontend npm dependencies could not be resolved/downloaded, and no live MongoDB, Cloudinary, Meta or Brevo credentials were available for provider integration tests. Run `npm ci && npm run build` for the frontend and install/test the backend in the target deployment environment before treating it as production-verified.
