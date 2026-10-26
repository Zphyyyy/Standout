// Admin-only. Lists organization requests, approves / rejects them, revokes access,
// and marks student achievements as verified.
// Approving creates the organization's login by emailing an invite to the OFFICIAL
// email address they proved they control, so no password or code is ever shared by hand.
import {
  HttpError, UUID_RE, esc, handle, json, requireUser, sendEmail,
} from "../_shared/util.ts";

const host = (u: string) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
};

Deno.serve(handle(async (req) => {
  const { user, db } = await requireUser(req, "admin");
  const b = await req.json().catch(() => ({}));
  const site = Deno.env.get("SITE_URL") ?? "";

  const needId = (v: unknown) => {
    if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, "Missing or invalid id.");
    return v;
  };

  switch (b.action) {
    case "list": {
      const { data: reqs, error } = await db.from("org_requests")
        .select("id, ref, status, legal_name, org_type, country, website, reg_no, email, phone, rep_name, rep_role, reg_doc_path, auth_doc_path, signature_path, email_verified, phone_verified, conduct_accepted, reason, created_at, reviewed_at, org_user_id")
        .neq("status", "draft").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      const sign = async (p: string | null) =>
        p ? (await db.storage.from("org-docs").createSignedUrl(p, 600)).data?.signedUrl ?? null : null;
      const requests = await Promise.all((reqs ?? []).map(async (r) => {
        const w = host(r.website), d = r.email.split("@")[1] ?? "";
        return {
          ...r,
          checks: {
            domain_matches_website: !!w && (d === w || d.endsWith("." + w)),
            email_verified: r.email_verified,
            phone_verified: r.phone_verified,
            documents_attached: !!(r.reg_doc_path && r.auth_doc_path),
            signature_captured: !!r.signature_path,
            conduct_accepted: r.conduct_accepted,
          },
          // Links expire in 10 minutes.
          registration_url: await sign(r.reg_doc_path),
          authorization_url: await sign(r.auth_doc_path),
          signature_url: await sign(r.signature_path),
          reg_doc_path: undefined, auth_doc_path: undefined, signature_path: undefined,
        };
      }));
      const { data: orgs } = await db.from("orgs").select("id, name, status, created_at").order("created_at", { ascending: false });
      const { data: reports } = await db.from("reports").select("id, conversation_id, reason, status, created_at").eq("status", "open");
      return json(req, { requests, orgs: orgs ?? [], reports: reports ?? [] });
    }

    case "approve": {
      const id = needId(b.request_id);
      const { data: r } = await db.from("org_requests").select("*").eq("id", id).maybeSingle();
      if (!r) throw new HttpError(404, "Request not found.");
      if (r.status !== "pending") throw new HttpError(409, "This request is not waiting for review.");
      if (!r.email_verified || !r.phone_verified || !r.signature_path || !r.conduct_accepted) {
        throw new HttpError(400, "Verification is incomplete, so this cannot be approved.");
      }
      const { data: inv, error } = await db.auth.admin.inviteUserByEmail(r.email, {
        redirectTo: `${site}/#org-welcome`,
        data: { org_name: r.legal_name },
      });
      if (error || !inv.user) throw new HttpError(409, error?.message ?? "Could not create the account (the email may already be in use).");
      const uid = inv.user.id;
      await db.from("profiles").upsert({ id: uid, role: "org" });
      const ins = await db.from("orgs").insert({ id: uid, name: r.legal_name, request_id: r.id, approved_by: user.id });
      if (ins.error) throw ins.error;
      await db.from("org_requests").update({
        status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString(), org_user_id: uid,
      }).eq("id", r.id);
      return json(req, { ok: true, org_id: uid });
    }

    case "reject": {
      const id = needId(b.request_id);
      const reason = String(b.reason ?? "").trim().slice(0, 300) || "We could not verify the organization.";
      const { data: r } = await db.from("org_requests").select("email, legal_name, ref, status").eq("id", id).maybeSingle();
      if (!r || r.status !== "pending") throw new HttpError(409, "This request is not waiting for review.");
      await db.from("org_requests").update({
        status: "rejected", reason, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
      }).eq("id", id);
      await sendEmail(r.email, "Your Standout account request",
        `<p>Thank you for applying, ${esc(r.legal_name)}. We could not approve request <b>${esc(r.ref)}</b>.</p><p>Reason: ${esc(reason)}</p><p>You are welcome to apply again with corrected details.</p>`).catch(() => {});
      return json(req, { ok: true });
    }

    case "revoke":
    case "restore": {
      const id = needId(b.org_id);
      const revoke = b.action === "revoke";
      await db.from("orgs").update({ status: revoke ? "revoked" : "active" }).eq("id", id);
      // Also block sign-in itself. RLS already cuts off data access immediately.
      await db.auth.admin.updateUserById(id, { ban_duration: revoke ? "876000h" : "none" });
      return json(req, { ok: true });
    }

    case "verify-achievement": {
      const id = needId(b.achievement_id);
      const on = b.verified !== false;
      const { error } = await db.from("achievements").update({
        verified: on, verified_by: on ? user.id : null, verified_at: on ? new Date().toISOString() : null,
      }).eq("id", id);
      if (error) throw error;
      return json(req, { ok: true });
    }

    case "resolve-report": {
      const id = needId(b.report_id);
      await db.from("reports").update({ status: "closed" }).eq("id", id);
      return json(req, { ok: true });
    }

    default:
      throw new HttpError(400, "Unknown action.");
  }
}));
