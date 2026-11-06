-- Personal Retro Assistant: goals, logs, and retros.
-- Postgres functions are the only API. Tables are not granted to anon or authenticated.
-- Every function is SECURITY DEFINER with an empty search_path, stops when auth.uid() is null,
-- and limits every read and write to rows owned by auth.uid().

create schema if not exists pra_private;
revoke all on schema pra_private from public, anon, authenticated;

-- Tables ---------------------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('physical', 'topic')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.activity_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category_id uuid references public.categories (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  unit text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_type_id uuid not null references public.activity_types (id) on delete cascade,
  value numeric not null check (value > 0),
  logged_on date not null,
  note text,
  created_at timestamptz not null default now()
);

create index activity_logs_user_type_day on public.activity_logs (user_id, activity_type_id, logged_on);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_type text not null check (goal_type in ('hard', 'soft')),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true,
  activity_type_id uuid references public.activity_types (id) on delete cascade,
  target_value numeric,
  period text,
  status text,
  created_at timestamptz not null default now(),
  constraint goal_shape check (
    (goal_type = 'hard'
      and activity_type_id is not null
      and target_value > 0
      and period in ('day', 'week')
      and status is null)
    or
    (goal_type = 'soft'
      and activity_type_id is null
      and target_value is null
      and period is null
      and status in ('not_started', 'in_progress', 'achieved', 'abandoned'))
  )
);

create table public.soft_goal_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  body text not null check (btrim(body) <> ''),
  created_at timestamptz not null default now()
);

create table public.retros (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('daily', 'weekly')),
  period_start date not null,
  body text not null default '',
  judgment text not null default '',
  next_focus text not null default '',
  updated_at timestamptz not null default now(),
  constraint retros_one_per_period unique (user_id, kind, period_start)
);

-- RLS on with no policies: a deny-all lock if a table grant ever slips in.
-- The functions run as the table owner and are the only path to the rows.
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.activity_types enable row level security;
alter table public.activity_logs enable row level security;
alter table public.goals enable row level security;
alter table public.soft_goal_checkins enable row level security;
alter table public.retros enable row level security;

-- Private helpers ------------------------------------------------------------------------------

-- Read-only on purpose: PostgREST runs STABLE functions in a read-only transaction.
create function pra_private.caller() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return uid;
end;
$$;

-- A user without a profile row yet reads as the default, UTC.
create function pra_private.timezone(uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.timezone from public.profiles p where p.user_id = uid), 'UTC');
$$;

create function pra_private.today(uid uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone pra_private.timezone(uid))::date;
$$;

create function pra_private.window_start(period text, d date) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if period = 'day' then
    return d;
  elsif period = 'week' then
    return date_trunc('week', d::timestamp)::date; -- ISO week: Monday
  end if;
  raise exception 'invalid_period';
end;
$$;

create function pra_private.window_end(period text, d date) returns date
language sql immutable set search_path = '' as $$
  select case when period = 'week' then pra_private.window_start(period, d) + 6
              else pra_private.window_start(period, d) end;
$$;

create function pra_private.retro_phase(body text, judgment text, next_focus text) returns text
language sql immutable set search_path = '' as $$
  select case
    when btrim(coalesce(body, '')) = '' then 'open'
    when btrim(coalesce(judgment, '')) <> '' and btrim(coalesce(next_focus, '')) <> '' then 'judged'
    else 'submitted'
  end;
$$;

create function pra_private.retro_period(kind text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if kind = 'daily' then return 'day'; end if;
  if kind = 'weekly' then return 'week'; end if;
  raise exception 'invalid_retro_kind';
end;
$$;

create function pra_private.retro_json(uid uuid, kind text, period_start date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'kind', retro_json.kind,
    'periodStart', retro_json.period_start,
    'body', coalesce(r.body, ''),
    'judgment', coalesce(r.judgment, ''),
    'nextFocus', coalesce(r.next_focus, ''),
    'phase', pra_private.retro_phase(r.body, r.judgment, r.next_focus),
    'updatedAt', r.updated_at
  )
  from (select 1) one
  left join public.retros r
    on r.user_id = uid and r.kind = retro_json.kind and r.period_start = retro_json.period_start;
$$;

create function pra_private.goal_json(g public.goals) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id,
    'goalType', g.goal_type,
    'name', g.name,
    'active', g.active,
    'activityTypeId', g.activity_type_id,
    'targetValue', g.target_value,
    'period', g.period,
    'status', g.status,
    'createdAt', g.created_at,
    'checkins', case when g.goal_type = 'soft' then coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'createdAt', c.created_at)
                       order by c.created_at)
      from public.soft_goal_checkins c
      where c.goal_id = g.id and c.user_id = g.user_id
    ), '[]'::jsonb) end
  );
$$;

create function pra_private.owned_goal(uid uuid, goal_id uuid) returns public.goals
language plpgsql security definer set search_path = '' as $$
declare
  g public.goals;
begin
  select * into g from public.goals where id = goal_id and user_id = uid for update;
  if not found then
    raise exception 'unknown_goal';
  end if;
  return g;
end;
$$;

-- API: profile ---------------------------------------------------------------------------------

create function public.set_timezone(timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = set_timezone.timezone) then
    raise exception 'invalid_timezone';
  end if;
  insert into public.profiles (user_id, timezone) values (uid, set_timezone.timezone)
  on conflict (user_id) do update set timezone = excluded.timezone;
  return jsonb_build_object('timezone', set_timezone.timezone);
end;
$$;

-- API: categories and activity types -----------------------------------------------------------

create function public.create_category(name text, kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  c public.categories;
begin
  if btrim(coalesce(name, '')) = '' or kind is null or kind not in ('physical', 'topic') then
    raise exception 'invalid_category';
  end if;
  insert into public.categories (user_id, name, kind)
  values (uid, btrim(create_category.name), create_category.kind)
  returning * into c;
  return jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'createdAt', c.created_at);
end;
$$;

create function public.list_categories() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'createdAt', c.created_at)
                     order by c.name)
    from public.categories c where c.user_id = uid
  ), '[]'::jsonb);
end;
$$;

create function public.create_activity_type(name text, unit text default '', "categoryId" uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  t public.activity_types;
begin
  if btrim(coalesce(name, '')) = '' then
    raise exception 'invalid_activity_type';
  end if;
  if "categoryId" is not null
     and not exists (select 1 from public.categories c where c.id = "categoryId" and c.user_id = uid) then
    raise exception 'unknown_category';
  end if;
  insert into public.activity_types (user_id, category_id, name, unit)
  values (uid, "categoryId", btrim(create_activity_type.name), btrim(coalesce(create_activity_type.unit, '')))
  returning * into t;
  return jsonb_build_object('id', t.id, 'name', t.name, 'unit', t.unit,
                            'categoryId', t.category_id, 'createdAt', t.created_at);
end;
$$;

create function public.list_activity_types() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'unit', t.unit,
                                        'categoryId', t.category_id, 'createdAt', t.created_at)
                     order by t.name)
    from public.activity_types t where t.user_id = uid
  ), '[]'::jsonb);
end;
$$;

-- API: activity logs ---------------------------------------------------------------------------

create function public.log_activity("activityTypeId" uuid, value numeric, "loggedOn" date default null,
                                    note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  l public.activity_logs;
begin
  if "activityTypeId" is null
     or not exists (select 1 from public.activity_types t where t.id = "activityTypeId" and t.user_id = uid) then
    raise exception 'unknown_activity';
  end if;
  if value is null or value <= 0 then
    raise exception 'invalid_value';
  end if;
  insert into public.activity_logs (user_id, activity_type_id, value, logged_on, note)
  values (uid, "activityTypeId", log_activity.value, coalesce("loggedOn", pra_private.today(uid)),
          nullif(btrim(log_activity.note), ''))
  returning * into l;
  return jsonb_build_object('id', l.id, 'activityTypeId', l.activity_type_id, 'value', l.value,
                            'loggedOn', l.logged_on, 'note', l.note, 'createdAt', l.created_at);
end;
$$;

create function public.list_activity_logs("fromDate" date default null, "toDate" date default null,
                                          "activityTypeId" uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', l.id, 'activityTypeId', l.activity_type_id,
                                        'activityName', t.name, 'unit', t.unit, 'value', l.value,
                                        'loggedOn', l.logged_on, 'note', l.note, 'createdAt', l.created_at)
                     order by l.logged_on desc, l.created_at desc)
    from public.activity_logs l
    join public.activity_types t on t.id = l.activity_type_id
    where l.user_id = uid
      and ("fromDate" is null or l.logged_on >= "fromDate")
      and ("toDate" is null or l.logged_on <= "toDate")
      and ("activityTypeId" is null or l.activity_type_id = "activityTypeId")
  ), '[]'::jsonb);
end;
$$;

-- API: goals -----------------------------------------------------------------------------------

create function public.create_goal("goalType" text, name text, "activityTypeId" uuid default null,
                                   "targetValue" numeric default null, period text default null,
                                   status text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  g public.goals;
begin
  if btrim(coalesce(name, '')) = '' then
    raise exception 'invalid_goal';
  end if;

  if "goalType" = 'hard' then
    if "activityTypeId" is null or "targetValue" is null or "targetValue" <= 0
       or period is null or period not in ('day', 'week') or status is not null then
      raise exception 'invalid_goal';
    end if;
    if not exists (select 1 from public.activity_types t where t.id = "activityTypeId" and t.user_id = uid) then
      raise exception 'unknown_activity';
    end if;
    insert into public.goals (user_id, goal_type, name, activity_type_id, target_value, period)
    values (uid, 'hard', btrim(create_goal.name), "activityTypeId", "targetValue", create_goal.period)
    returning * into g;
  elsif "goalType" = 'soft' then
    if "activityTypeId" is not null or "targetValue" is not null or period is not null
       or coalesce(status, 'not_started') not in ('not_started', 'in_progress', 'achieved', 'abandoned') then
      raise exception 'invalid_goal';
    end if;
    insert into public.goals (user_id, goal_type, name, status)
    values (uid, 'soft', btrim(create_goal.name), coalesce(create_goal.status, 'not_started'))
    returning * into g;
  else
    raise exception 'invalid_goal';
  end if;

  return pra_private.goal_json(g);
end;
$$;

create function public.set_goal_active("goalId" uuid, active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  g public.goals := pra_private.owned_goal(uid, "goalId");
begin
  if active is null then
    raise exception 'invalid_goal';
  end if;
  update public.goals set active = set_goal_active.active where id = g.id returning * into g;
  return pra_private.goal_json(g);
end;
$$;

create function public.set_soft_goal_status("goalId" uuid, status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  g public.goals := pra_private.owned_goal(uid, "goalId");
begin
  if g.goal_type <> 'soft' then
    raise exception 'not_soft_goal';
  end if;
  if status is null or status not in ('not_started', 'in_progress', 'achieved', 'abandoned') then
    raise exception 'invalid_status';
  end if;
  update public.goals set status = set_soft_goal_status.status where id = g.id returning * into g;
  return pra_private.goal_json(g);
end;
$$;

create function public.add_soft_goal_checkin("goalId" uuid, body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  g public.goals := pra_private.owned_goal(uid, "goalId");
  c public.soft_goal_checkins;
begin
  if g.goal_type <> 'soft' then
    raise exception 'not_soft_goal';
  end if;
  if btrim(coalesce(body, '')) = '' then
    raise exception 'invalid_checkin';
  end if;
  insert into public.soft_goal_checkins (user_id, goal_id, body)
  values (uid, g.id, btrim(add_soft_goal_checkin.body))
  returning * into c;
  return jsonb_build_object('id', c.id, 'goalId', c.goal_id, 'body', c.body, 'createdAt', c.created_at);
end;
$$;

create function public.list_goals("includeInactive" boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
begin
  return coalesce((
    select jsonb_agg(pra_private.goal_json(g) order by g.created_at)
    from public.goals g
    where g.user_id = uid and (g.active or coalesce("includeInactive", false))
  ), '[]'::jsonb);
end;
$$;

-- API: periods and retros ----------------------------------------------------------------------

-- One period's view: per-activity sums, active goals with derived progress, and the retro.
-- Sums are computed here from the logs and never stored. A hard goal's sum covers the goal's own
-- day or Monday-to-Sunday window that contains the requested date.
create function public.get_period(period text default 'day', "date" date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  anchor date := coalesce("date", pra_private.today(uid));
  w_start date;
  w_end date;
begin
  if period is null or period not in ('day', 'week') then
    raise exception 'invalid_period';
  end if;
  w_start := pra_private.window_start(period, anchor);
  w_end := pra_private.window_end(period, anchor);

  return jsonb_build_object(
    'period', period,
    'date', anchor,
    'start', w_start,
    'end', w_end,
    'timezone', pra_private.timezone(uid),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object('activityTypeId', s.id, 'name', s.name, 'unit', s.unit,
                                          'sum', s.total, 'count', s.n)
                       order by s.name)
      from (
        select t.id, t.name, t.unit, sum(l.value) as total, count(*) as n
        from public.activity_logs l
        join public.activity_types t on t.id = l.activity_type_id and t.user_id = uid
        where l.user_id = uid and l.logged_on between w_start and w_end
        group by t.id, t.name, t.unit
      ) s
    ), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(
        pra_private.goal_json(g) || case when g.goal_type = 'hard' then jsonb_build_object(
          'windowStart', pra_private.window_start(g.period, anchor),
          'windowEnd', pra_private.window_end(g.period, anchor),
          'sum', coalesce((
            select sum(l.value) from public.activity_logs l
            where l.user_id = uid
              and l.activity_type_id = g.activity_type_id
              and l.logged_on between pra_private.window_start(g.period, anchor)
                                  and pra_private.window_end(g.period, anchor)
          ), 0)
        ) else '{}'::jsonb end
        order by g.created_at)
      from public.goals g
      where g.user_id = uid and g.active
    ), '[]'::jsonb),
    'retro', pra_private.retro_json(uid, case when period = 'week' then 'weekly' else 'daily' end, w_start)
  );
end;
$$;

-- A judged retro is closed: its body no longer changes, so the judgment keeps matching it.
create function public.write_retro(kind text, body text, "date" date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  p_start date := pra_private.window_start(pra_private.retro_period(kind),
                                           coalesce("date", pra_private.today(uid)));
  r public.retros;
begin
  select * into r from public.retros
  where user_id = uid and retros.kind = write_retro.kind and period_start = p_start
  for update;
  if found and pra_private.retro_phase(r.body, r.judgment, r.next_focus) = 'judged' then
    raise exception 'retro_judged';
  end if;
  insert into public.retros (user_id, kind, period_start, body)
  values (uid, write_retro.kind, p_start, coalesce(write_retro.body, ''))
  on conflict on constraint retros_one_per_period
  do update set body = excluded.body, updated_at = now();
  return pra_private.retro_json(uid, kind, p_start);
end;
$$;

create function public.set_retro_judgment(kind text, judgment text, "nextFocus" text, "date" date default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := pra_private.caller();
  p_start date := pra_private.window_start(pra_private.retro_period(kind),
                                           coalesce("date", pra_private.today(uid)));
  r public.retros;
begin
  select * into r from public.retros
  where user_id = uid and retros.kind = set_retro_judgment.kind and period_start = p_start
  for update;
  if not found or btrim(r.body) = '' then
    raise exception 'retro_open';
  end if;
  if btrim(coalesce(judgment, '')) = '' or btrim(coalesce("nextFocus", '')) = '' then
    raise exception 'invalid_judgment';
  end if;
  update public.retros
  set judgment = set_retro_judgment.judgment, next_focus = "nextFocus", updated_at = now()
  where id = r.id;
  return pra_private.retro_json(uid, kind, p_start);
end;
$$;

-- Privileges -----------------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema pra_private from public, anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function
  public.set_timezone(text),
  public.create_category(text, text),
  public.list_categories(),
  public.create_activity_type(text, text, uuid),
  public.list_activity_types(),
  public.log_activity(uuid, numeric, date, text),
  public.list_activity_logs(date, date, uuid),
  public.create_goal(text, text, uuid, numeric, text, text),
  public.set_goal_active(uuid, boolean),
  public.set_soft_goal_status(uuid, text),
  public.add_soft_goal_checkin(uuid, text),
  public.list_goals(boolean),
  public.get_period(text, date),
  public.write_retro(text, text, date),
  public.set_retro_judgment(text, text, text, date)
to authenticated;
