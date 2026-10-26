# Standout backend

A ready-to-deploy backend for the Standout student showcase site, built on **Supabase** (Postgres database, login, file storage, live updates, serverless functions). You do not run or maintain a server.

> **Status:** written but not yet deployed or tested against a live project. Expect to fix small things on first run, and test every flow below before real students use it.

## What is in the box

```
supabase/
  config.toml
  migrations/001_schema.sql        Tables, security rules (RLS), messaging functions, storage
  functions/
    _shared/util.ts                Shared helpers (auth check, rate limits, email, SMS)
    org-request/                   Organizations request an account (3-step verification)
    admin-review-org/              Admin approves / rejects / revokes, verifies achievements
    scan-certificate/              AI certificate reading (Claude API key stays on the server)
    guardian/                      Parent or guardian consent for students
client/standout-api.js             Browser code your HTML page uses to talk to the backend
.env.example                       Secrets you need to set
```

## How the security works

- **Students** sign up themselves. **Organizations cannot sign up.** They submit a request, prove control of an official email on their website's domain and of a phone number (codes), upload a registration certificate and a signed authorization letter, and draw a signature. Nothing is created until **you approve**. Approval emails an invite to the verified official address, so no password or code is ever passed around by hand.
- **Only approved, active organizations** can see student profiles, message them, or reveal a phone number. This is enforced inside the database (Row Level Security), not in the web page, so it cannot be bypassed from the browser.
- **Students under guardian control:** a profile cannot be listed until a parent or guardian confirms through an emailed one-time link.
- Students can block or report a conversation, and can see every organization that revealed their phone number.
- Revoking an organization cuts off its access immediately.
- AI scan results are saved as **unverified** until an admin (or later, the issuer or school) marks them verified.

## Setup (about 1 hour)

1. **Create a project** at supabase.com. Note the Project URL and the `anon` public key (Settings, API).
2. **Create the database.** Open the SQL editor, paste `supabase/migrations/001_schema.sql`, and run it.
3. **Set up email sending.** Supabase's built-in email is heavily limited. Create a Resend account (or any SMTP provider), verify your domain, then add its SMTP details in Authentication, SMTP. Turn on "Confirm email" under Authentication, Providers, Email.
4. **Set the site address.** Authentication, URL Configuration: set Site URL to your website and add the same address to Redirect URLs.
5. **Install the CLI** and link the project:
   ```
   npm i -g supabase
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```
6. **Set secrets.** Copy `.env.example` to `.env`, fill it in, then run:
   ```
   supabase secrets set --env-file ./.env
   ```
7. **Deploy the functions:**
   ```
   supabase functions deploy org-request
   supabase functions deploy admin-review-org
   supabase functions deploy scan-certificate
   supabase functions deploy guardian
   ```
8. **Make yourself the first admin.** Sign up on the site with your email, then run in the SQL editor:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
9. **Host the web page yourself.** The copy published inside Claude cannot reach your backend, because it blocks outside network calls. Put the HTML on Netlify, Vercel or Cloudflare Pages, and use that address for `SITE_URL` and `ALLOWED_ORIGINS`.

## Connecting the HTML page

Copy `client/standout-api.js` next to your `index.html` and create the client with your Project URL and `anon` key. Then replace the browser-only code:

| In the prototype | Replace with |
|---|---|
| Student profile saved in localStorage | `api.saveMyStudent(...)`, `api.getMyStudent()` |
| Add / remove achievement | `api.addAchievement(a)`, `api.deleteAchievement(id)` |
| Certificate scan (`claude.use("sample")`) | `api.scanCertificate(file)` |
| Discover list (sample students) | `api.listStudents()` after an organization signs in |
| Shortlist | `api.shortlist()`, `api.toggleShortlist(id, on)` |
| Message / Call buttons | `api.sendMessage(id, text)`, `api.revealPhone(id)` |
| Notifications inbox | `api.inbox()`, `api.reply()`, `api.markRead()`, `api.subscribeMessages(cb)` |
| Organization request wizard | `api.orgRequestCreate / orgSendCodes / orgVerify / orgSubmit / orgStatus` |
| Admin tab | `api.adminList / adminApprove / adminReject / adminRevoke` |
| Org sign-in with ID and code | Normal email and password sign-in (`api.signIn`); the org sets its password from the invite email (`api.setPassword`) |

Screens you still need to add: student and organization **sign-up / sign-in**, a **guardian page** that reads `#guardian=TOKEN` from the address and calls `api.guardianConfirm(token)`, and a **set-password** screen for the invite link. Remove the demo codes box from the organization wizard, because codes now arrive by email and SMS.

## Decisions to make

- **Public browsing.** As written, only approved organizations and admins can see student profiles; the public sees nothing. This is the safest default for minors. If you want a public gallery, add a limited view (for example first name, school and achievement titles only) rather than opening the tables.
- **SMS in India** requires registering sender IDs and templates (DLT). Swap `sendSms` in `_shared/util.ts` for MSG91 or another local provider.
- **Costs:** Supabase, Resend and Netlify have free tiers that suit a pilot. The AI scan costs a small amount per certificate; limits are 4 per minute and 20 per day per student.

## Before real students use it

- Many users are **minors**. In India the Digital Personal Data Protection Act 2023 requires verifiable parental consent for children's data, and restricts tracking and targeted advertising aimed at them. Get a lawyer to review your privacy policy, consent wording, data-retention and deletion process.
- Certificates sent for scanning go to Anthropic's API. Read its current data-retention terms and mention this in your privacy policy.
- Test that: an organization that is not approved sees nothing; a revoked one loses access immediately; a student cannot read another student's phone number; and a student cannot list themselves without guardian consent.
- Add monitoring for failed function calls, and decide who reviews reports.
