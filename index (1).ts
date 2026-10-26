// Parent / guardian consent. A student's profile cannot be listed until their
// guardian confirms through a one-time link sent to the guardian's email.
//   send    (signed-in student): emails the guardian a consent link
//   confirm (public):            the guardian's click turns consent on
import {
  HttpError, clientIp, esc, handle, json, randomHex, rate, requireUser, sendEmail, serviceClient, sha256,
} from "../_shared/util.ts";

Deno.serve(handle(async (req) => {
  const b = await req.json().catch(() => ({}));
  const site = Deno.env.get("SITE_URL") ?? "";

  if (b.action === "send") {
    const { user, db } = await requireUser(req, "student");
    await rate(db, `guardian:send:${user.id}`, 3, 86400);
    const { data: s } = await db.from("students").select("full_name").eq("id", user.id).maybeSingle();
    const { data: priv } = await db.from("student_private").select("guardian_email").eq("id", user.id).maybeSingle();
    if (!s || !priv?.guardian_email) throw new HttpError(400, "Save your profile with a parent or guardian email first.");

    const token = randomHex(32);
    await db.from("guardian_tokens").insert({
      token_hash: await sha256(token), student_id: user.id,
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const link = `${site}/#guardian=${token}`;
    await sendEmail(priv.guardian_email, `Please approve ${s.full_name}'s Standout profile`,
      `<p>${esc(s.full_name)} has created a student profile on Standout, a site where verified universities and organizations can discover students' achievements.</p>
       <p>By approving, you agree that their name, school, grade and achievements may be shown to approved organizations, who may message them. You can ask us to remove the profile at any time.</p>
       <p><a href="${link}">Review and approve</a> (this link works once and expires in 7 days).</p>
       <p>If you did not expect this email, ignore it and nothing will be shown.</p>`);
    return json(req, { sent: true });
  }

  if (b.action === "confirm") {
    const db = serviceClient();
    await rate(db, `guardian:confirm:${clientIp(req)}`, 20, 3600);
    const token = String(b.token ?? "");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(400, "This link is not valid.");
    const { data: t } = await db.from("guardian_tokens").select("*").eq("token_hash", await sha256(token)).maybeSingle();
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(410, "This link has expired or was already used.");
    await db.from("students").update({ guardian_consent: true, guardian_consent_at: new Date().toISOString() }).eq("id", t.student_id);
    await db.from("guardian_tokens").update({ used_at: new Date().toISOString() }).eq("token_hash", t.token_hash);
    return json(req, { ok: true });
  }

  throw new HttpError(400, "Unknown action.");
}));
