-- =====================================================================
-- Standout backend schema (Supabase / Postgres)
-- Run once in the Supabase SQL editor, or with `supabase db push`.
-- Security model: every table has Row Level Security (RLS). Browsers only
-- hold the public "anon" key, so RLS and the RPC functions below are what
-- actually protect student data. Never ship the service_role key to a browser.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('student','org','admin')),
  created_at timestamptz not null default now()
);

-- Everyone who signs up on their own is a student. Organization accounts are
-- created only by the admin-review-org function, and admins only by SQL.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, role) values (new.id, 'student') on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- ---------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------
create table public.students (
  id                  uuid primary key references public.profiles(id) on delete cascade,
  full_name           text not null check (char_length(full_name) between 1 and 60),
  school              text not null default '' check (char_length(school) <= 80),
  grade               int  check (grade between 1 and 12),
  bio                 text not null default '' check (char_length(bio) <= 240),
  hue                 int  not null default 175 check (hue between 0 and 360),
  visible             boolean not null default false,   -- student chose to be listed
  allow_calls         boolean not null default false,   -- student chose to share a phone number
  guardian_consent    boolean not null default false,   -- set only by the guardian function
  guardian_consent_at timestamptz,
  created_at          timestamptz not null default now(),
  constraint visible_needs_consent check (not visible or guardian_consent)
);

-- Phone and guardian email are never exposed to organizations directly.
create table public.student_private (
  id             uuid primary key references public.students(id) on delete cascade,
  phone          text check (phone is null or phone ~ '^[+0-9 -]{7,20}$'),
  guardian_email text check (guardian_email is null or char_length(guardian_email) <= 120)
);

-- A student cannot grant themselves guardian consent.
create function public.guard_student_flags() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), 'service_role') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    new.guardian_consent := false; new.guardian_consent_at := null;
  else
    new.guardian_consent := old.guardian_consent; new.guardian_consent_at := old.guardian_consent_at;
  end if;
  return new;
end $$;
create trigger students_guard before insert or update on public.students
  for each row execute function public.guard_student_flags();

create table public.achievements (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.students(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 90),
  field         text not null check (char_length(field) between 1 and 40),
  kind          text not null check (char_length(kind) between 1 and 40),
  year          int  not null check (year between 2000 and 2100),
  issuer        text not null default '' check (char_length(issuer) <= 60),
  description   text not null default '' check (char_length(description) <= 200),
  evidence_path text,
  verified      boolean not null default false,
  verified_by   uuid references public.profiles(id),
  verified_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index achievements_student_idx on public.achievements(student_id);

-- Only an admin (or the server) can mark an achievement as verified.
create function public.guard_verified() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), 'service_role') = 'service_role' or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.verified := false; new.verified_by := null; new.verified_at := null;
  else
    new.verified := old.verified; new.verified_by := old.verified_by; new.verified_at := old.verified_at;
  end if;
  return new;
end $$;
create trigger achievements_guard before insert or update on public.achievements
  for each row execute function public.guard_verified();

-- ---------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------
create table public.orgs (
  id          uuid primary key references public.profiles(id) on delete cascade,
  name        text not null,
  request_id  uuid,
  status      text not null default 'active' check (status in ('active','revoked')),
  approved_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create function public.is_active_org() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.orgs where id = auth.uid() and status = 'active')
$$;

-- Access requests. Written ONLY by the org-request / admin-review-org
-- functions (service role). No RLS policies = no access from browsers.
create table public.org_requests (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique default ('REQ-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6))),
  secret_hash     text not null,
  status          text not null default 'draft' check (status in ('draft','pending','approved','rejected')),
  legal_name      text not null,
  org_type        text not null,
  country         text not null,
  website         text not null,
  reg_no          text not null,
  email           text not null,
  phone           text not null,
  rep_name        text not null,
  rep_role        text not null,
  reg_doc_path    text,
  auth_doc_path   text,
  signature_path  text,
  email_verified  boolean not null default false,
  phone_verified  boolean not null default false,
  conduct_accepted boolean not null default false,
  reason          text,
  reviewed_by     uuid references public.profiles(id),
  reviewed_at     timestamptz,
  org_user_id     uuid,
  created_at      timestamptz not null default now()
);
create index org_requests_status_idx on public.org_requests(status, created_at desc);

create table public.org_otps (
  request_id uuid not null references public.org_requests(id) on delete cascade,
  kind       text not null check (kind in ('email','phone')),
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   int  not null default 0,
  primary key (request_id, kind)
);

create table public.guardian_tokens (
  token_hash text primary key,
  student_id uuid not null references public.students(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table public.rate_events (
  key text not null,
  at  timestamptz not null default now()
);
create index rate_events_key_at on public.rate_events(key, at desc);

create function public.check_rate(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.rate_events where at < now() - interval '2 days';
  select count(*) into n from public.rate_events
    where key = p_key and at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then return false; end if;
  insert into public.rate_events (key) values (p_key);
  return true;
end $$;
revoke all on function public.check_rate(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate(text, int, int) to service_role;

-- ---------------------------------------------------------------------
-- Messaging, shortlists, reports, audit
-- ---------------------------------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  blocked    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, student_id)
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id),
  body            text not null check (char_length(body) between 1 and 1000),
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index messages_conv_idx on public.messages(conversation_id, created_at);

create table public.shortlists (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, student_id)
);

create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles(id),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason          text not null check (char_length(reason) between 1 and 500),
  status          text not null default 'open' check (status in ('open','closed')),
  created_at      timestamptz not null default now()
);

-- Every time an organization reveals a student's phone number it is logged,
-- and the student can see the log.
create table public.phone_reveals (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.students        enable row level security;
alter table public.student_private enable row level security;
alter table public.achievements    enable row level security;
alter table public.orgs            enable row level security;
alter table public.org_requests    enable row level security;   -- no policies on purpose
alter table public.org_otps        enable row level security;   -- no policies on purpose
alter table public.guardian_tokens enable row level security;   -- no policies on purpose
alter table public.rate_events     enable row level security;   -- no policies on purpose
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.shortlists      enable row level security;
alter table public.reports         enable row level security;
alter table public.phone_reveals   enable row level security;

create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_admin());

-- students: owner, admin, or an ACTIVE organization looking at a listed, consented student
create policy students_read on public.students for select using (
  id = auth.uid() or public.is_admin()
  or (public.is_active_org() and visible and guardian_consent));
create policy students_insert on public.students for insert
  with check (id = auth.uid() and public.my_role() = 'student');
create policy students_update on public.students for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy students_delete on public.students for delete using (id = auth.uid());

create policy student_private_owner on public.student_private for all
  using (id = auth.uid()) with check (id = auth.uid());

create policy ach_read on public.achievements for select using (
  student_id = auth.uid() or public.is_admin()
  or (public.is_active_org() and exists (
        select 1 from public.students s
        where s.id = achievements.student_id and s.visible and s.guardian_consent)));
create policy ach_write on public.achievements for insert with check (student_id = auth.uid());
create policy ach_update on public.achievements for update
  using (student_id = auth.uid() or public.is_admin()) with check (student_id = auth.uid() or public.is_admin());
create policy ach_delete on public.achievements for delete using (student_id = auth.uid());

create policy orgs_read on public.orgs for select using (id = auth.uid() or public.is_admin());

create policy conv_read on public.conversations for select using (
  (org_id = auth.uid() and public.is_active_org()) or student_id = auth.uid() or public.is_admin());
-- Students may only change the "blocked" flag on their own conversations.
revoke update on public.conversations from authenticated;
grant update (blocked) on public.conversations to authenticated;
create policy conv_block on public.conversations for update
  using (student_id = auth.uid()) with check (student_id = auth.uid());

create policy msg_read on public.messages for select using (
  exists (select 1 from public.conversations c
          where c.id = messages.conversation_id
            and ((c.org_id = auth.uid() and public.is_active_org()) or c.student_id = auth.uid()))
  or (public.is_admin() and exists (select 1 from public.reports r where r.conversation_id = messages.conversation_id)));
-- Messages are written only through send_message / reply_message below.
revoke insert, update, delete on public.messages from authenticated;

create policy shortlist_owner on public.shortlists for all
  using (org_id = auth.uid() and public.is_active_org())
  with check (org_id = auth.uid() and public.is_active_org());

create policy reports_insert on public.reports for insert with check (
  reporter_id = auth.uid() and exists (select 1 from public.conversations c
    where c.id = conversation_id and (c.org_id = auth.uid() or c.student_id = auth.uid())));
create policy reports_read on public.reports for select using (reporter_id = auth.uid() or public.is_admin());
create policy reports_admin_update on public.reports for update using (public.is_admin());

create policy reveals_read on public.phone_reveals for select
  using (student_id = auth.uid() or org_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- RPCs called by the website
-- ---------------------------------------------------------------------
create function public.send_message(p_student uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_conv uuid; v_body text := btrim(p_body);
begin
  if not public.is_active_org() then
    raise exception 'Only verified organizations can message students' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'Message must be 1 to 1000 characters';
  end if;
  if not exists (select 1 from public.students s where s.id = p_student and s.visible and s.guardian_consent) then
    raise exception 'This student is not available';
  end if;
  if (select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.org_id = auth.uid() and m.sender_id = auth.uid() and m.created_at > now() - interval '1 day') >= 50 then
    raise exception 'Daily message limit reached';
  end if;
  insert into public.conversations (org_id, student_id) values (auth.uid(), p_student)
    on conflict (org_id, student_id) do nothing;
  select id into v_conv from public.conversations where org_id = auth.uid() and student_id = p_student;
  if (select blocked from public.conversations where id = v_conv) then
    raise exception 'This student is not accepting messages from you' using errcode = '42501';
  end if;
  insert into public.messages (conversation_id, sender_id, body) values (v_conv, auth.uid(), v_body);
  return v_conv;
end $$;

create function public.reply_message(p_conv uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_body text := btrim(p_body);
begin
  if char_length(v_body) not between 1 and 1000 then raise exception 'Message must be 1 to 1000 characters'; end if;
  if not exists (select 1 from public.conversations c
                 where c.id = p_conv and c.student_id = auth.uid() and not c.blocked) then
    raise exception 'Conversation not available' using errcode = '42501';
  end if;
  insert into public.messages (conversation_id, sender_id, body) values (p_conv, auth.uid(), v_body);
end $$;

create function public.mark_read(p_conv uuid) returns void
language sql security definer set search_path = '' as $$
  update public.messages m set read_at = now()
  where m.conversation_id = p_conv and m.sender_id <> auth.uid() and m.read_at is null
    and exists (select 1 from public.conversations c
                where c.id = p_conv and (c.org_id = auth.uid() or c.student_id = auth.uid()));
$$;

create function public.reveal_phone(p_student uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_phone text;
begin
  if not public.is_active_org() then
    raise exception 'Only verified organizations can call students' using errcode = '42501';
  end if;
  if not exists (select 1 from public.students s
                 where s.id = p_student and s.visible and s.guardian_consent and s.allow_calls) then
    raise exception 'This student has not shared a phone number';
  end if;
  select phone into v_phone from public.student_private where id = p_student;
  if v_phone is null then raise exception 'This student has not shared a phone number'; end if;
  insert into public.phone_reveals (org_id, student_id) values (auth.uid(), p_student);
  return v_phone;
end $$;

revoke all on function public.send_message(uuid, text)  from public, anon;
revoke all on function public.reply_message(uuid, text) from public, anon;
revoke all on function public.mark_read(uuid)           from public, anon;
revoke all on function public.reveal_phone(uuid)        from public, anon;
grant execute on function public.send_message(uuid, text)  to authenticated;
grant execute on function public.reply_message(uuid, text) to authenticated;
grant execute on function public.mark_read(uuid)           to authenticated;
grant execute on function public.reveal_phone(uuid)        to authenticated;

-- ---------------------------------------------------------------------
-- Storage (private buckets)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('evidence', 'evidence', false, 8388608, array['image/jpeg','image/png','image/webp','application/pdf']),
  ('org-docs', 'org-docs', false, 8388608, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- Students manage files in their own folder: evidence/<their user id>/...
create policy evidence_owner on storage.objects for all to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);

-- Active organizations can read evidence of listed, consented students.
create policy evidence_org_read on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and public.is_active_org() and exists (
    select 1 from public.students s
    where s.id::text = (storage.foldername(name))[1] and s.visible and s.guardian_consent));

-- 'org-docs' has no policies: only the server (service role) can touch it.

-- Live updates for the inbox.
alter publication supabase_realtime add table public.messages;

-- ---------------------------------------------------------------------
-- After deploying: make yourself the first admin
--   1. Sign up on the site with your own email.
--   2. Run (replace the email):
--      update public.profiles set role = 'admin'
--      where id = (select id from auth.users where email = 'you@example.com');
-- ---------------------------------------------------------------------
