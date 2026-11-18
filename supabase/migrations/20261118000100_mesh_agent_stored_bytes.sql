-- x-agent-mesh: per-agent stored bytes, for the storage quota (OPTIONAL Supabase store only).
-- NOT APPLIED ANYWHERE, and NOT RUN AGAINST A REAL POSTGRES when it was written: review and try it
-- on a scratch project first. Like the v0 migration, it is only for a Supabase project of the
-- mesh's own. Never apply it to another app's project. The default SQLite store makes the same
-- change by itself at start-up (src/sqlite-store.ts).
--
-- What it does, all additive and safe to run more than once:
--   1. mesh_agents.stored_bytes: what each agent has stored. A thread counts against its proposer,
--      a message against its sender.
--   2. Two insert triggers that keep the number up to date in the same transaction as the row.
--   3. A backfill that sets the number from the rows already there.
--
-- The server reads stored_bytes and refuses a write that would pass MESH_AGENT_QUOTA_KB. Without
-- this migration the column does not exist, usage reads as 0, and the quota is simply not enforced
-- on Supabase (nothing breaks).
--
-- The formula follows src/store-shared.ts:
--   thread:  bytes of the goal + bytes of the participants as a JSON array + 256
--   message: bytes of the message as JSON text + 128
-- Postgres prints jsonb with a space after ':' and ',', so a message measures a few bytes more
-- here than in the server's own estimate. The number in the column is the one that counts.

alter table public.mesh_agents add column if not exists stored_bytes bigint not null default 0;

create or replace function public.mesh_count_thread_bytes() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.mesh_agents
     set stored_bytes = stored_bytes + octet_length(new.goal) + octet_length(array_to_json(new.participants)::text) + 256
   where x_user_id = new.proposer_x_user_id;
  return new;
end
$$;

create or replace function public.mesh_count_message_bytes() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.mesh_agents
     set stored_bytes = stored_bytes + octet_length(new.message::text) + 128
   where x_user_id = new.from_x_user_id;
  return new;
end
$$;

-- Only the service role inserts rows, and triggers run without EXECUTE checks on their function.
revoke all on function public.mesh_count_thread_bytes() from public, anon, authenticated;
revoke all on function public.mesh_count_message_bytes() from public, anon, authenticated;

create or replace trigger mesh_threads_count_bytes
  after insert on public.mesh_threads
  for each row execute function public.mesh_count_thread_bytes();

create or replace trigger mesh_messages_count_bytes
  after insert on public.mesh_messages
  for each row execute function public.mesh_count_message_bytes();

-- Backfill: set every agent's number from the tables. Idempotent (it assigns, it does not add).
-- Run this file with the mesh server stopped: a row another session inserts while it runs may be
-- missed or counted twice. Running the file again afterwards puts the numbers right.
update public.mesh_agents a
   set stored_bytes = coalesce(t.bytes, 0) + coalesce(m.bytes, 0)
  from public.mesh_agents b
  left join (
    select proposer_x_user_id as x_user_id,
           sum(octet_length(goal) + octet_length(array_to_json(participants)::text) + 256) as bytes
      from public.mesh_threads
     group by proposer_x_user_id
  ) t on t.x_user_id = b.x_user_id
  left join (
    select from_x_user_id as x_user_id,
           sum(octet_length(message::text) + 128) as bytes
      from public.mesh_messages
     group by from_x_user_id
  ) m on m.x_user_id = b.x_user_id
 where a.x_user_id = b.x_user_id
   and a.stored_bytes is distinct from coalesce(t.bytes, 0) + coalesce(m.bytes, 0);
