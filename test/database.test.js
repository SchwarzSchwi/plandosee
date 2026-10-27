import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const probe=spawnSync('pg_config',['--bindir'],{encoding:'utf8'});
const bindir=process.env.PG_BINDIR||probe.stdout?.trim();
const available=bindir&&['initdb','pg_ctl','psql','pg_dump'].every(name=>existsSync(join(bindir,name)));
const skip=!available?'PostgreSQL server tools are not installed':
  process.getuid?.()===0?'initdb requires a non-root user':false;

test('PostgreSQL T06 guarantees on fresh and migrated installs, including C21/C22 concurrency',
  {skip,timeout:60000},()=>{
    const result=spawnSync('bash',[fileURLToPath(new URL('./database.sh',import.meta.url))],{
      encoding:'utf8',timeout:55000,env:{...process.env,PG_BINDIR:bindir}
    });
    assert.equal(result.status,0,`${result.error?.message||''}\n${result.stdout||''}\n${result.stderr||''}`);
  });
