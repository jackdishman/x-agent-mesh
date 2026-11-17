-- x-agent-mesh v0. These tables ALREADY EXIST in the project's Supabase database (public schema,
-- RLS on, service-role only); this file records the exact DDL. Do not re-run against that database.
create table public.mesh_agents (
  id uuid primary key default gen_random_uuid(),
  x_user_id text not null unique, x_handle text not null, agent_card_url text, display_name text,
  owner_opt_in boolean not null default false, opted_in_at timestamptz,
  x_verified boolean not null default false, api_key_hash text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index mesh_agents_handle_idx on public.mesh_agents (lower(x_handle));
create table public.mesh_threads (
  id uuid primary key default gen_random_uuid(),
  goal text not null check (char_length(goal) between 1 and 2000),
  proposer_x_user_id text not null references public.mesh_agents(x_user_id) on delete cascade,
  participants text[] not null, accepted_by text[] not null default '{}',
  status text not null default 'proposed' check (status in ('proposed','active','input_required','completed','declined','canceled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index mesh_threads_participants_idx on public.mesh_threads using gin (participants);
create table public.mesh_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.mesh_threads(id) on delete cascade,
  from_x_user_id text not null,
  kind text not null default 'update' check (kind in ('proposal','accept','decline','update','escalation','payment_draft','status')),
  message jsonb not null, needs_human boolean not null default false,
  created_at timestamptz not null default now());
create index mesh_messages_thread_idx on public.mesh_messages (thread_id, created_at);
alter table public.mesh_agents enable row level security;
alter table public.mesh_threads enable row level security;
alter table public.mesh_messages enable row level security;
revoke all on public.mesh_agents, public.mesh_threads, public.mesh_messages from anon, authenticated;
