import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  seoulDate, mondayStart, observationSummary, validateObservation, STUDY_METRIC,
} from '../public/model.js';

// Synthetic fixtures exist only in this test process and the isolated throwaway database.
const synthetic = (date, minutes) => ({ observed_date: date, actual_minutes: minutes });

test('T07: Seoul midnight and Monday week start include Sunday and year boundaries', () => {
  assert.equal(seoulDate(new Date('2026-10-25T14:59:59.999Z')), '2026-10-25');
  assert.equal(seoulDate(new Date('2026-10-25T15:00:00.000Z')), '2026-10-26');
  assert.equal(mondayStart('2026-10-25'), '2026-10-19');
  assert.equal(mondayStart('2026-10-26'), '2026-10-26');
  assert.equal(mondayStart('2027-01-01'), '2026-12-28');
});

test('T07: incomplete data stays pending; missing is not zero; exactly five real dates complete', () => {
  const empty = observationSummary([]);
  assert.equal(empty.complete, false);
  assert.equal(empty.total.sum, null);
  assert.equal(empty.before.average, null);
  assert.equal(empty.after.average, null);
  const records = [synthetic('2026-10-20', 0), synthetic('2026-10-22', 4)];
  const partial = observationSummary(records);
  assert.equal(partial.complete, false);
  assert.equal(partial.remaining, 3);
  assert.equal(partial.before.average, 2);
  assert.equal(partial.after.sum, null);
  records.push(synthetic('2026-10-23', 1), synthetic('2026-10-25', 2), synthetic('2026-10-26', 2));
  const complete = observationSummary(records);
  assert.equal(complete.complete, true);
  assert.equal(complete.total.sum, 9);
  assert.equal(complete.total.average, 1.8);
  assert.equal(complete.after.average, 1.67);
  assert.equal(STUDY_METRIC, 'actual_minutes');
  assert.equal(records[0].observed_date, '2026-10-20');
});

test('T07: integer bounds, missing input, duplicate dates, future dates and third-day rule gate', () => {
  const first = [synthetic('2026-10-25', 10)];
  for (const value of [-1, 1441, 1.5, NaN, null, '', undefined]) {
    assert.throws(() => validateObservation([], value, '2026-10-26', '2026-10-26'));
  }
  for (const value of [0, 1440]) assert.doesNotThrow(() =>
    validateObservation([], value, '2026-10-26', '2026-10-26'));
  assert.throws(() => validateObservation(first, 4, '2026-10-25', '2026-10-25'), /이미/);
  assert.throws(() => validateObservation(first, 4, '2026-10-24', '2026-10-20'), /미래/);
  assert.throws(() => validateObservation([], 4, '2026-10-24', '2026-10-25'), /생성일/);
  const two = [...first, synthetic('2026-10-26', 20)];
  assert.throws(() => validateObservation(two, 4, '2026-10-27', '2026-10-25'), /규칙/);
  assert.doesNotThrow(() => validateObservation(two, 4, '2026-10-27', '2026-10-25', true));
  assert.throws(() => observationSummary([...first, ...first]));
  assert.throws(() => observationSummary([synthetic('2026-10-26', 1441)]));
  assert.throws(() => observationSummary([synthetic('2026-10-26', null)]));
  const five = Array.from({ length: 5 }, (_, i) => synthetic(`2026-10-${20 + i}`, i));
  assert.throws(() => validateObservation(five, 0, '2026-10-26', '2026-10-20', true), /5일/);
});

test('T07: initial HTML contains only login, with no hidden private application DOM', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="loginForm"/);
  assert.doesNotMatch(html, /data-tab|id="app"|id="export"|localStorage|남이 봐도/);
  const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.match(script, /if \(!verified && !publicActions.includes/);
});

test('T07: account forms preserve the exact backend password and deletion field contract', () => {
  const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(script, /field\('현재 비밀번호', 'current_password', 'password'\)/);
  assert.match(script, /field\('새 비밀번호', 'new_password', 'password'\)/);
  assert.match(script, /form\('deleteAccountForm', \[field\('비밀번호 확인', 'current_password', 'password'\)\]/);
  assert.match(script, /request\(\{ action: 'password' \}, 'POST', values\)/);
  assert.match(script, /request\(\{ action: 'delete-account' \}, 'POST', values\)/);
});

const probe = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
const bindir = process.env.PG_BINDIR || probe.stdout?.trim();
const available = bindir && ['initdb', 'pg_ctl', 'psql'].every(name => existsSync(join(bindir, name)));
const skip = !available ? 'PostgreSQL server tools unavailable'
  : process.getuid?.() === 0 ? 'initdb requires a non-root user' : false;

test('T07 PostgreSQL: service-only ownership, immutable evidence, server dates and five-day gate',
  { skip, timeout: 60000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'plandosee-observation-'));
    mkdirSync(join(scratch, 'socket'), { recursive: true });
    const command = (name, args, input) => {
      const result = spawnSync(join(bindir, name), args, {
        encoding: 'utf8', input, timeout: 30000,
        env: { ...process.env, PGHOST: join(scratch, 'socket'), PGPORT: '55439', PGUSER: process.env.USER },
      });
      assert.equal(result.status, 0, `${name}: ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const sql = input => command('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], input);
    try {
      command('initdb', ['-D', join(scratch, 'data'), '-A', 'trust', '--no-locale']);
      command('pg_ctl', ['-D', join(scratch, 'data'), '-l', join(scratch, 'server.log'),
        '-o', `-k ${join(scratch, 'socket')} -p 55439 -c listen_addresses=''`, '-w', 'start']);
      sql(`
        create role anon; create role authenticated; create role service_role bypassrls;
        create table auth_accounts(id uuid primary key);
        create function export_data() returns jsonb language sql stable as $$
          select '{"version":1,"plans":[],"tasks":[],"execution_logs":[],"reviews":[],"plan_versions":[]}'::jsonb;
        $$;
        insert into auth_accounts values ('07000000-0000-4000-8000-000000000001'), ('07000000-0000-4000-8000-000000000002');
        create function authorized_request(p_token_hash text, p_operation text) returns jsonb language plpgsql as $$
        begin
          if p_token_hash not in ('synthetic-a', 'synthetic-b') or p_token_hash is null then
            raise exception 'Session required' using errcode='28000';
          end if;
          return jsonb_build_object('id', case when p_token_hash='synthetic-a'
            then '07000000-0000-4000-8000-000000000001' else '07000000-0000-4000-8000-000000000002' end);
        end $$;
      `);
      sql(readFileSync(new URL('../supabase/migrations/003_t07_observations.sql', import.meta.url), 'utf8'));
      sql(`
        create function synthetic_reject(statement text, expected text default null) returns void language plpgsql as $$
        begin
          begin execute statement;
          exception when others then
            if expected is not null and sqlstate <> expected then raise; end if;
            return;
          end;
          raise exception 'Synthetic test expected rejection: %', statement;
        end $$;
        do $$ declare s jsonb; o jsonb; sid uuid; begin
          assert not has_function_privilege('anon','observation_request(text,text,jsonb)','execute');
          assert not has_function_privilege('authenticated','observation_request(text,text,jsonb)','execute');
          assert has_function_privilege('service_role','observation_request(text,text,jsonb)','execute');
          assert not has_table_privilege('anon','observations','select');
          assert not has_table_privilege('authenticated','studies','insert');
          perform synthetic_reject($q$select observation_request(null,'study')$q$, '28000');
          s := observation_request('synthetic-a','create-study','{"initial_rule":"Synthetic initial rule"}');
          sid := (s->>'id')::uuid;
          assert (s->>'created_date')::date = (clock_timestamp() at time zone 'Asia/Seoul')::date;
          perform synthetic_reject(format($q$select observation_request('synthetic-b','observe','{"study_id":"%s","actual_minutes":1}')$q$,sid),'P0002');
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":1,"observed_date":"2000-01-01"}')$q$,sid),'22023');
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":1,"created_at":"2000-01-01"}')$q$,sid),'22023');
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":1441}')$q$,sid),'22023');
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":1.5}')$q$,sid),'22023');
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":null}')$q$,sid),'22023');
          o := observation_request('synthetic-a','observe',jsonb_build_object('study_id',sid,'actual_minutes',0));
          assert (o->>'day_number')::integer = 1;
          assert (o->>'actual_minutes')::integer = 0;
          assert (o->>'observed_date')::date = (clock_timestamp() at time zone 'Asia/Seoul')::date;
          assert (o->>'created_at')::timestamptz <= clock_timestamp();
          perform synthetic_reject(format($q$select observation_request('synthetic-a','observe','{"study_id":"%s","actual_minutes":1}')$q$,sid),'23505');
          perform synthetic_reject(format($q$update studies set initial_rule='changed' where id='%s'$q$,sid),'22023');
          perform synthetic_reject(format($q$update observations set actual_minutes=5 where study_id='%s'$q$,sid),'22023');
          assert jsonb_array_length(observation_request('synthetic-b','study')->'studies')=0;
          assert jsonb_array_length(export_data()->'studies')=0;
          perform observation_request('synthetic-a','study');
          assert jsonb_array_length(export_data()->'studies')=1;
          assert jsonb_array_length(export_data()->'observations')=1;
        end $$;
        set role service_role;
        select observation_request('synthetic-b','study');
        select export_data();
        reset role;

        -- Historical synthetic fixtures are inserted only into this disposable test database.
        alter table observations disable trigger observations_assign;
        insert into studies(id,owner_id,initial_rule,created_at,created_date) values
          ('07000000-0000-4000-8000-000000000010','07000000-0000-4000-8000-000000000001','Synthetic old rule',
           clock_timestamp()-interval '10 days',(clock_timestamp() at time zone 'Asia/Seoul')::date-10);
        insert into observations(id,owner_id,study_id,day_number,observed_date,actual_minutes,created_at) values
          ('07000000-0000-4000-8000-000000000011','07000000-0000-4000-8000-000000000001','07000000-0000-4000-8000-000000000010',1,(clock_timestamp() at time zone 'Asia/Seoul')::date-4,10,clock_timestamp()-interval '4 days'),
          ('07000000-0000-4000-8000-000000000012','07000000-0000-4000-8000-000000000001','07000000-0000-4000-8000-000000000010',2,(clock_timestamp() at time zone 'Asia/Seoul')::date-3,20,clock_timestamp()-interval '3 days');
        alter table observations enable trigger observations_assign;
        do $$ declare r jsonb; o jsonb; begin
          perform synthetic_reject($q$select observation_request('synthetic-a','observe','{"study_id":"07000000-0000-4000-8000-000000000010","actual_minutes":30}')$q$,'22023');
          perform synthetic_reject($q$select observation_request('synthetic-a','rule-change','{"study_id":"07000000-0000-4000-8000-000000000010","day1_id":"07000000-0000-4000-8000-000000000012","day2_id":"07000000-0000-4000-8000-000000000011","rule":"Synthetic new rule","reason":"Synthetic evidence"}')$q$,'23503');
          r := observation_request('synthetic-a','rule-change','{"study_id":"07000000-0000-4000-8000-000000000010","day1_id":"07000000-0000-4000-8000-000000000011","day2_id":"07000000-0000-4000-8000-000000000012","rule":"Synthetic new rule","reason":"Synthetic evidence"}');
          assert r->>'day1_id'='07000000-0000-4000-8000-000000000011';
          assert (r->>'created_at')::timestamptz <= clock_timestamp();
          perform synthetic_reject($q$update rule_changes set reason='changed'$q$,'22023');
          o := observation_request('synthetic-a','observe','{"study_id":"07000000-0000-4000-8000-000000000010","actual_minutes":30}');
          assert (o->>'day_number')::integer=3;
          assert o->>'rule_change_id'=r->>'id';
        end $$;
        alter table observations disable trigger observations_assign;
        insert into observations(owner_id,study_id,day_number,observed_date,actual_minutes,rule_change_id,created_at)
          select owner_id,study_id,n,(clock_timestamp() at time zone 'Asia/Seoul')::date+n,40,id,clock_timestamp()
            from rule_changes cross join generate_series(4,5) n;
        alter table observations enable trigger observations_assign;
        select synthetic_reject($q$select observation_request('synthetic-a','observe','{"study_id":"07000000-0000-4000-8000-000000000010","actual_minutes":1}')$q$,'22023');
        delete from auth_accounts where id='07000000-0000-4000-8000-000000000001';
        do $$ begin
          assert (select count(*)=0 from studies);
          assert (select count(*)=0 from observations);
          assert (select count(*)=0 from rule_changes);
        end $$;
      `);
    } finally {
      spawnSync(join(bindir, 'pg_ctl'), ['-D', join(scratch, 'data'), '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
