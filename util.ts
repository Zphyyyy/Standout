// Shared helpers for all Standout edge functions (Deno runtime).
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---- CORS: only your own website(s) may call these functions from a browser ----
export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] ?? ""),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Use POST");
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
      console.error(e);
      return json(req, { error: "Something went wrong. Please try again." }, 500);
    }
  };
}

// ---- Supabase clients ----
// Service-role client: full access. Use ONLY inside functions, never in a browser.
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// Verifies the caller's session token and (optionally) their role.
export async function requireUser(req: Request, role?: "student" | "org" | "admin") {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "Please sign in first.");
  const db = serviceClient();
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Please sign in again.");
  const { data: p } = await db.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (role && p?.role !== role) throw new HttpError(403, "You are not allowed to do this.");
  return { user: data.user, role: (p?.role ?? "") as string, db };
}

// ---- Small utilities ----
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const randomHex = (bytes = 32) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const otp = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function str(v: unknown, max: number, label: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HttpError(400, `Enter the ${label}.`);
  if (s.length > max) throw new HttpError(400, `The ${label} is too long.`);
  return s;
}

export async function rate(db: SupabaseClient, key: string, max: number, windowSeconds: number) {
  const { data, error } = await db.rpc("check_rate", { p_key: key, p_max: max, p_window_seconds: windowSeconds });
  if (error) throw error;
  if (!data) throw new HttpError(429, "Too many attempts. Please try again later.");
}

// ---- Email (Resend: https://resend.com) ----
export async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.warn("RESEND_API_KEY missing; email not sent:", subject); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("MAIL_FROM"), to: [to], subject, html }),
  });
  if (!r.ok) { console.error("Email failed", r.status, await r.text()); throw new HttpError(502, "Could not send the email. Check the address and try again."); }
}

// ---- SMS (Twilio by default). In India, SMS needs DLT registration; swap this
// function for MSG91, Gupshup or another local provider if you prefer. ----
export async function sendSms(to: string, text: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), token = Deno.env.get("TWILIO_AUTH_TOKEN"), from = Deno.env.get("TWILIO_FROM");
  if (!sid || !token || !from) { console.warn("Twilio not configured; SMS not sent"); return; }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to.replace(/[^+\d]/g, ""), From: from, Body: text }),
  });
  if (!r.ok) { console.error("SMS failed", r.status, await r.text()); throw new HttpError(502, "Could not send the SMS. Check the phone number and try again."); }
}

export const FREE_EMAIL = new Set([
  "gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "live.com", "icloud.com",
  "proton.me", "protonmail.com", "rediffmail.com", "aol.com", "mail.com",
]);
