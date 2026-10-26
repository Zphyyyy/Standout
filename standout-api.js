// Browser client for the Standout backend. Replaces the localStorage code in the HTML page.
// The anon key below is PUBLIC by design; Row Level Security protects the data.
// NEVER put the service_role key or any API key in this file.
//
// Usage in your HTML:
//   <script type="module">
//     import { createApi } from "./standout-api.js";
//     const api = createApi("https://YOUR-PROJECT.supabase.co", "YOUR-ANON-KEY");
//     const { role } = await api.me();
//   </script>
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

export function createApi(SUPABASE_URL, SUPABASE_ANON_KEY) {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Calls an edge function and turns server errors into readable Error messages.
  async function fn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return data;
  }
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const toB64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
  const extOf = (f) => (f.name.split(".").pop() || "pdf").toLowerCase();

  return {
    sb,

    // ---------------- accounts ----------------
    async signUp(email, password) { return must(await sb.auth.signUp({ email, password })); },
    async signIn(email, password) { return must(await sb.auth.signInWithPassword({ email, password })); },
    async signOut() { await sb.auth.signOut(); },
    async setPassword(password) { return must(await sb.auth.updateUser({ password })); }, // used from the org invite link
    onAuth(cb) { return sb.auth.onAuthStateChange((_e, s) => cb(s)); },
    // -> { id, role: "student" | "org" | "admin" } or null when signed out
    async me() {
      const { data } = await sb.auth.getUser();
      if (!data.user) return null;
      const { data: p } = await sb.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
      return { id: data.user.id, email: data.user.email, role: p ? p.role : null };
    },

    // ---------------- student: profile ----------------
    async getMyStudent() {
      const { data: u } = await sb.auth.getUser();
      const s = must(await sb.from("students").select("*").eq("id", u.user.id).maybeSingle());
      const p = must(await sb.from("student_private").select("*").eq("id", u.user.id).maybeSingle());
      return s ? { ...s, phone: p?.phone || "", guardian_email: p?.guardian_email || "" } : null;
    },
    // fields: full_name, school, grade, bio, hue, visible, allow_calls, phone, guardian_email
    async saveMyStudent(f) {
      const { data: u } = await sb.auth.getUser();
      const id = u.user.id;
      must(await sb.from("students").upsert({
        id, full_name: f.full_name, school: f.school || "", grade: f.grade ? Number(f.grade) : null,
        bio: f.bio || "", hue: f.hue ?? 175, visible: !!f.visible, allow_calls: !!f.allow_calls,
      }));
      must(await sb.from("student_private").upsert({ id, phone: f.phone || null, guardian_email: f.guardian_email || null }));
    },
    async requestGuardianConsent() { return fn("guardian", { action: "send" }); },
    async guardianConfirm(token) { return fn("guardian", { action: "confirm", token }); }, // call from the #guardian=TOKEN page

    // ---------------- student: achievements ----------------
    async myAchievements() {
      const { data: u } = await sb.auth.getUser();
      return must(await sb.from("achievements").select("*").eq("student_id", u.user.id).order("year", { ascending: false }));
    },
    // a: { title, field, kind, year, issuer, description, evidence_path? }
    async addAchievement(a) {
      const { data: u } = await sb.auth.getUser();
      return must(await sb.from("achievements").insert({ ...a, student_id: u.user.id }).select().single());
    },
    async deleteAchievement(id) { must(await sb.from("achievements").delete().eq("id", id)); },
    // Uploads a certificate image/PDF to the student's private folder and returns its path.
    async uploadEvidence(file) {
      const { data: u } = await sb.auth.getUser();
      const path = `${u.user.id}/${crypto.randomUUID()}.${extOf(file)}`;
      must(await sb.storage.from("evidence").upload(path, file, { contentType: file.type }));
      return path;
    },
    async evidenceUrl(path) { return must(await sb.storage.from("evidence").createSignedUrl(path, 300)).signedUrl; },
    // AI scan: pass a File/Blob (JPG, PNG, WEBP or PDF, ideally under 5 MB). Returns the fields to pre-fill.
    async scanCertificate(file) {
      return fn("scan-certificate", { media_type: file.type, data: await toB64(file) });
    },

    // ---------------- organizations: browse students ----------------
    // Organizations and admins only (enforced by RLS). Filtering is done in the browser for now.
    async listStudents() {
      return must(await sb.from("students")
        .select("id, full_name, school, grade, bio, hue, allow_calls, achievements(id, title, field, kind, year, issuer, description, verified, evidence_path)")
        .order("created_at", { ascending: false }).limit(200));
    },
    async shortlist() { return must(await sb.from("shortlists").select("student_id")).map((r) => r.student_id); },
    async toggleShortlist(studentId, on) {
      const { data: u } = await sb.auth.getUser();
      if (on) must(await sb.from("shortlists").upsert({ org_id: u.user.id, student_id: studentId }));
      else must(await sb.from("shortlists").delete().eq("org_id", u.user.id).eq("student_id", studentId));
    },

    // ---------------- messaging (organizations <-> students) ----------------
    async sendMessage(studentId, body) { return must(await sb.rpc("send_message", { p_student: studentId, p_body: body })); },
    async reply(conversationId, body) { must(await sb.rpc("reply_message", { p_conv: conversationId, p_body: body })); },
    async markRead(conversationId) { must(await sb.rpc("mark_read", { p_conv: conversationId })); },
    // Conversations with their messages. For students, org name is included.
    async inbox() {
      return must(await sb.from("conversations")
        .select("id, blocked, org:orgs(name), student:students(full_name), messages(id, sender_id, body, created_at, read_at)")
        .order("created_at", { ascending: false }));
    },
    async unreadCount() {
      const { data: u } = await sb.auth.getUser();
      const { count } = await sb.from("messages").select("id", { count: "exact", head: true }).is("read_at", null).neq("sender_id", u.user.id);
      return count || 0;
    },
    // Live updates: cb(newMessageRow) fires when a message arrives.
    subscribeMessages(cb) {
      return sb.channel("messages-feed")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => cb(p.new))
        .subscribe();
    },
    async block(conversationId, blocked = true) { must(await sb.from("conversations").update({ blocked }).eq("id", conversationId)); },
    async report(conversationId, reason) {
      const { data: u } = await sb.auth.getUser();
      must(await sb.from("reports").insert({ reporter_id: u.user.id, conversation_id: conversationId, reason }));
    },
    // Organizations only. Returns the phone number and logs that it was revealed.
    async revealPhone(studentId) { return must(await sb.rpc("reveal_phone", { p_student: studentId })); },
    async whoSawMyPhone() { // students: transparency log
      return must(await sb.from("phone_reveals").select("at, org:orgs(name)").order("at", { ascending: false }));
    },

    // ---------------- organization access request (public, no login) ----------------
    // fields: legal_name, org_type, country, website, reg_no, email, phone, rep_name, rep_role
    // files: { registration: File, authorization: File }; signature: PNG data URL from the canvas
    async orgRequestCreate(fields, files, signature) {
      const res = await fn("org-request", {
        action: "create", ...fields, signature,
        ext: { registration: extOf(files.registration), authorization: extOf(files.authorization) },
      });
      for (const k of ["registration", "authorization"]) {
        const u = res.uploads[k];
        must(await sb.storage.from("org-docs").uploadToSignedUrl(u.path, u.token, files[k]));
      }
      return { request_id: res.request_id, secret: res.secret, ref: res.ref }; // keep `secret` in memory only
    },
    async orgSendCodes(h) { return fn("org-request", { action: "send-codes", ...h }); },
    async orgVerify(h, emailCode, phoneCode) { return fn("org-request", { action: "verify", ...h, email_code: emailCode, phone_code: phoneCode }); },
    async orgSubmit(h, conduct) { return fn("org-request", { action: "submit", ...h, conduct }); },
    async orgStatus(ref, email) { return fn("org-request", { action: "status", ref, email }); },

    // ---------------- admin ----------------
    async adminList() { return fn("admin-review-org", { action: "list" }); },
    async adminApprove(requestId) { return fn("admin-review-org", { action: "approve", request_id: requestId }); },
    async adminReject(requestId, reason) { return fn("admin-review-org", { action: "reject", request_id: requestId, reason }); },
    async adminRevoke(orgId) { return fn("admin-review-org", { action: "revoke", org_id: orgId }); },
    async adminRestore(orgId) { return fn("admin-review-org", { action: "restore", org_id: orgId }); },
    async adminVerifyAchievement(id, verified = true) { return fn("admin-review-org", { action: "verify-achievement", achievement_id: id, verified }); },
    async adminResolveReport(id) { return fn("admin-review-org", { action: "resolve-report", report_id: id }); },
  };
}
