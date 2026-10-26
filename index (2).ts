// Public endpoint: an organization asks for an account.
// Actions: create -> (client uploads documents) -> send-codes -> verify -> submit, plus status.
// Nothing here creates an account. Only an admin can approve (see admin-review-org).
import {
  FREE_EMAIL, HttpError, UUID_RE, clientIp, esc, handle, json, otp, randomHex, rate,
  sendEmail, sendSms, serviceClient, sha256, str,
} from "../_shared/util.ts";

const TYPES = ["University", "College or school", "Company", "NGO or foundation", "Government body", "Other"];
const DOC_EXT = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
const MAX_SIG_B64 = 400_000;

const host = (u: string) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
};

async function load(db: ReturnType<typeof serviceClient>, b: Record<string, unknown>, statuses = ["draft"]) {
  const id = String(b.request_id ?? ""), secret = String(b.secret ?? "");
  if (!UUID_RE.test(id) || secret.length < 32) throw new HttpError(400, "Missing request details.");
  const { data } = await db.from("org_requests").select("*").eq("id", id).maybeSingle();
  if (!data || data.secret_hash !== await sha256(secret) || !statuses.includes(data.status)) {
    throw new HttpError(404, "Request not found.");
  }
  return data;
}

Deno.serve(handle(async (req) => {
  const b = await req.json().catch(() => ({}));
  const db = serviceClient();

  switch (b.action) {
    // ---------- Steps 1 + 2: organization details, documents, signature ----------
    case "create": {
      await rate(db, `orgreq:ip:${clientIp(req)}`, 5, 3600);
      const legal = str(b.legal_name, 120, "legal name");
      const orgType = str(b.org_type, 60, "organization type");
      if (!TYPES.includes(orgType) && orgType.length < 2) throw new HttpError(400, "Choose the organization type.");
      const country = str(b.country, 60, "country");
      const website = str(b.website, 120, "website");
      const regNo = str(b.reg_no, 60, "registration number");
      const email = str(b.email, 120, "official email").toLowerCase();
      const phone = str(b.phone, 20, "phone number");
      const rep = str(b.rep_name, 80, "authorized person's name");
      const role = str(b.rep_role, 80, "designation");

      const m = email.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
      if (!m) throw new HttpError(400, "Enter a valid email address.");
      const w = host(website);
      if (!w.includes(".")) throw new HttpError(400, "Enter a valid website address.");
      if (FREE_EMAIL.has(m[1])) throw new HttpError(400, "Use an official email on your organization's own domain, not a free email address.");
      if (!(m[1] === w || m[1].endsWith("." + w))) throw new HttpError(400, `Your email domain (${m[1]}) must match your website (${w}).`);
      if (!/^[+\d][\d\s-]{6,19}$/.test(phone)) throw new HttpError(400, "Enter a valid phone number.");
      await rate(db, `orgreq:email:${email}`, 3, 86400);

      const sig = String(b.signature ?? "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!sig || sig[1].length > MAX_SIG_B64) throw new HttpError(400, "A signature is required.");

      const secret = randomHex(32);
      const { data: row, error } = await db.from("org_requests").insert({
        secret_hash: await sha256(secret), legal_name: legal, org_type: orgType, country, website, reg_no: regNo,
        email, phone, rep_name: rep, rep_role: role,
      }).select("id, ref").single();
      if (error) throw error;

      const bytes = Uint8Array.from(atob(sig[1]), (c) => c.charCodeAt(0));
      const up = await db.storage.from("org-docs").upload(`${row.id}/signature.png`, bytes, { contentType: "image/png", upsert: true });
      if (up.error) throw up.error;

      // The browser uploads the two documents straight to private storage using these one-time tokens.
      const uploads: Record<string, { path: string; token: string }> = {};
      for (const k of ["registration", "authorization"]) {
        const ext = String(b.ext?.[k] ?? "pdf").toLowerCase();
        if (!DOC_EXT.has(ext)) throw new HttpError(400, "Documents must be PDF, PNG, JPG or WEBP.");
        const path = `${row.id}/${k}.${ext}`;
        const { data: u, error: ue } = await db.storage.from("org-docs").createSignedUploadUrl(path);
        if (ue || !u) throw ue ?? new HttpError(500, "Could not prepare the upload.");
        uploads[k] = { path, token: u.token };
      }
      await db.from("org_requests").update({
        signature_path: `${row.id}/signature.png`,
        reg_doc_path: uploads.registration.path,
        auth_doc_path: uploads.authorization.path,
      }).eq("id", row.id);

      return json(req, { request_id: row.id, secret, ref: row.ref, uploads });
    }

    // ---------- Step 3a: send one code to the email and one to the phone ----------
    case "send-codes": {
      const r = await load(db, b);
      await rate(db, `orgreq:codes:${r.id}`, 5, 3600);
      const e = otp(), p = otp();
      const expires = new Date(Date.now() + 10 * 60_000).toISOString();
      const { error } = await db.from("org_otps").upsert([
        { request_id: r.id, kind: "email", code_hash: await sha256(`${r.id}:email:${e}`), expires_at: expires, attempts: 0 },
        { request_id: r.id, kind: "phone", code_hash: await sha256(`${r.id}:phone:${p}`), expires_at: expires, attempts: 0 },
      ]);
      if (error) throw error;
      await db.from("org_requests").update({ email_verified: false, phone_verified: false }).eq("id", r.id);
      await sendEmail(r.email, "Your Standout verification code",
        `<p>Your verification code is <b style="font-size:20px">${e}</b>.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`);
      await sendSms(r.phone, `Standout verification code: ${p}. It expires in 10 minutes.`);
      return json(req, { sent: true });
    }

    // ---------- Step 3b: check both codes ----------
    case "verify": {
      const r = await load(db, b);
      await rate(db, `orgreq:verify:${r.id}`, 20, 3600);
      const { data: rows } = await db.from("org_otps").select("*").eq("request_id", r.id);
      const flags = { email: r.email_verified as boolean, phone: r.phone_verified as boolean };
      for (const kind of ["email", "phone"] as const) {
        if (flags[kind]) continue;
        const row = rows?.find((x) => x.kind === kind);
        if (!row || new Date(row.expires_at) < new Date() || row.attempts >= 5) continue;
        const code = String(b[`${kind}_code`] ?? "").trim();
        if (await sha256(`${r.id}:${kind}:${code}`) === row.code_hash) {
          flags[kind] = true;
          await db.from("org_requests").update({ [`${kind}_verified`]: true }).eq("id", r.id);
        } else {
          await db.from("org_otps").update({ attempts: row.attempts + 1 }).eq("request_id", r.id).eq("kind", kind);
        }
      }
      return json(req, {
        email_verified: flags.email, phone_verified: flags.phone,
        message: flags.email && flags.phone ? "Both codes verified." : "One or both codes are wrong or expired. Check them, or request new codes.",
      });
    }

    // ---------- Final: lock the request and queue it for the admin ----------
    case "submit": {
      const r = await load(db, b);
      if (!r.email_verified || !r.phone_verified) throw new HttpError(400, "Verify both codes first.");
      if (b.conduct !== true) throw new HttpError(400, "Please accept the code of conduct.");
      const { data: files } = await db.storage.from("org-docs").list(r.id);
      const names = (files ?? []).map((f) => f.name);
      const reg = names.find((n) => n.startsWith("registration."));
      const auth = names.find((n) => n.startsWith("authorization."));
      if (!reg || !auth || !names.includes("signature.png")) throw new HttpError(400, "Upload both documents and sign before submitting.");
      await db.from("org_requests").update({
        status: "pending", conduct_accepted: true,
        reg_doc_path: `${r.id}/${reg}`, auth_doc_path: `${r.id}/${auth}`,
      }).eq("id", r.id);
      const admin = Deno.env.get("ADMIN_EMAIL");
      if (admin) {
        await sendEmail(admin, `New organization request: ${r.legal_name}`,
          `<p>${esc(r.legal_name)} (${esc(r.country)}) has requested an account. Reference <b>${esc(r.ref)}</b>.</p><p>Open the admin dashboard to review it.</p>`).catch(() => {});
      }
      return json(req, { ref: r.ref, status: "pending" });
    }

    // ---------- Status check (needs both the reference and the email used) ----------
    case "status": {
      await rate(db, `orgreq:status:${clientIp(req)}`, 20, 3600);
      const ref = String(b.ref ?? "").trim().toUpperCase(), email = String(b.email ?? "").trim().toLowerCase();
      const { data } = await db.from("org_requests").select("status, reason").eq("ref", ref).eq("email", email).maybeSingle();
      if (!data) throw new HttpError(404, "No request found with that reference and email.");
      return json(req, data);
    }

    default:
      throw new HttpError(400, "Unknown action.");
  }
}));
