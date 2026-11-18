-- x-agent-mesh: one agent per X handle, compared without case (OPTIONAL Supabase store only).
-- NOT APPLIED ANYWHERE: like the v0 migration, this is only for a Supabase project of the mesh's
-- own, should it ever get one. Never apply it to another app's project. The default SQLite store
-- makes the same change by itself at start-up (src/sqlite-store.ts).
--
-- Safe to run more than once, and it never deletes or changes a row: if two agents already share a
-- handle, it creates nothing and says so. Resolve the duplicates by hand, then run it again.
--
-- With the index in place, the server turns a unique violation on it (SQLSTATE 23505) into the
-- usual "This x_handle is already registered to a different x_user_id." conflict, so two
-- registrations racing for one handle cannot both succeed.
do $$
declare
  dup text;
begin
  select string_agg(format('@%s (%s agents)', h, n), ', ')
    into dup
    from (
      select lower(x_handle) as h, count(*) as n
        from public.mesh_agents
       group by lower(x_handle)
      having count(*) > 1
       order by 1
       limit 5
    ) d;
  if dup is not null then
    raise warning 'x-agent-mesh: handles registered more than once: %. The unique index mesh_agents_handle_uniq was NOT created and no row was changed.', dup;
  else
    create unique index if not exists mesh_agents_handle_uniq on public.mesh_agents (lower(x_handle));
  end if;
end
$$;
