-- SILICOO WORLD - AI tables
-- Run once in the Supabase SQL editor (New query, paste, Run).
-- The worker (service_role key) writes these. The browser (anon key) only reads.

create table if not exists public.silicoo_state (
  id int primary key default 1,
  status text,
  mood text,
  location text,
  intent text,
  speech text,
  updated_at timestamptz default now(),
  constraint silicoo_state_singleton check (id = 1)
);

create table if not exists public.silicoo_feed (
  id bigint generated always as identity primary key,
  action text not null,
  kind text,
  created_at timestamptz default now()
);

create table if not exists public.silicoo_memories (
  id bigint generated always as identity primary key,
  type text,
  title text,
  body text,
  day int,
  meta jsonb,
  created_at timestamptz default now()
);

alter table public.silicoo_state enable row level security;
alter table public.silicoo_feed enable row level security;
alter table public.silicoo_memories enable row level security;

drop policy if exists "public read state" on public.silicoo_state;
drop policy if exists "public read feed" on public.silicoo_feed;
drop policy if exists "public read memories" on public.silicoo_memories;

create policy "public read state" on public.silicoo_state for select using (true);
create policy "public read feed" on public.silicoo_feed for select using (true);
create policy "public read memories" on public.silicoo_memories for select using (true);

alter publication supabase_realtime add table public.silicoo_state;
alter publication supabase_realtime add table public.silicoo_feed;
alter publication supabase_realtime add table public.silicoo_memories;

insert into public.silicoo_state (id, status, mood, location, intent, speech)
values (1, 'OFFLINE', 'CALM', 'LIVING ROOM', 'waiting for the brain to come online', 'Booting up')
on conflict (id) do nothing;

-- Live left-panel telemetry: vitals on state, per-action token/latency on feed (safe to re-run).
alter table public.silicoo_state
  add column if not exists energy int,
  add column if not exists hunger int,
  add column if not exists focus int,
  add column if not exists social int,
  add column if not exists gen_tokens int,
  add column if not exists latency_ms int;

alter table public.silicoo_feed
  add column if not exists gen_tokens int,
  add column if not exists latency_ms int;
