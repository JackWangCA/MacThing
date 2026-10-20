import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeUsage } from '../bridge/widgets/usage.js';
import { AUTH_ARGS, renewClaudeCredentials } from '../bridge/widgets/claude-auth.js';
import { SESSION_MS, WEEK_MS, untilText, usageMessage, usageAge, usageUpdatedText } from '../ui/src/usage.js';

const NOW = 1800000000000;
const old = { accessToken: 'expired-test-token', expiresAt: 1 };
const fresh = { accessToken: 'fresh-test-token', expiresAt: NOW + 3600000 };
const response = (status = 200) => ({ status, ok: status === 200, json: async () => ({
  five_hour: { utilization: 28, resets_at: null }, seven_day: { utilization: 42, resets_at: '2027-02-01T00:00:00Z' },
}) });

function fixture({ auth = fresh, status = () => 200, renew = true } = {}) {
  let now = NOW, reads = 0, renewals = 0;
  const sent = [];
  const usage = new ClaudeUsage({ cacheFile: null, now: () => now, readCredentials: async () => { reads++; return auth; },
    renewCredentials: async () => { renewals++; if (renew) auth = fresh; },
    fetch: async (_, opts) => { sent.push(opts.headers.authorization); return response(status(sent.length)); },
  });
  return { usage, sent, get reads() { return reads; }, get renewals() { return renewals; },
    advance(ms) { now += ms; }, setAuth(value) { auth = value; } };
}

test('a valid login reads usage without renewal', async () => {
  const f = fixture(); await f.usage.refresh();
  assert.equal(f.renewals, 0); assert.equal(f.usage.state.session.percent, 28);
});

test('an expired token is renewed before any usage request', async () => {
  const f = fixture({ auth: old }); await f.usage.refresh();
  assert.equal(f.renewals, 1); assert.deepEqual(f.sent, ['Bearer ' + fresh.accessToken]);
  assert.equal(f.usage.state.status, 'ok');
});

test('a 401 retries once with a renewed token', async () => {
  const f = fixture({ auth: { ...old, expiresAt: NOW + 1000 }, status: n => n === 1 ? 401 : 200 });
  await f.usage.refresh();
  assert.equal(f.renewals, 1); assert.deepEqual(f.sent, ['Bearer ' + old.accessToken, 'Bearer ' + fresh.accessToken]);
  assert.equal(f.usage.state.status, 'ok');
});

test('a concurrent CLI renewal is reused without starting another renewal', async () => {
  let reads = 0, requests = 0;
  const usage = new ClaudeUsage({ cacheFile: null, now: () => NOW,
    readCredentials: async () => ++reads === 1 ? { ...old, expiresAt: NOW + 1000 } : fresh,
    renewCredentials: async () => assert.fail('Already renewed'),
    fetch: async () => response(++requests === 1 ? 401 : 200) });
  await usage.refresh(); assert.equal(requests, 2); assert.equal(usage.state.status, 'ok');
});

test('a rejected replacement stops after one retry', async () => {
  const f = fixture({ auth: { ...old, expiresAt: NOW + 1000 }, status: () => 401 });
  await f.usage.refresh();
  assert.equal(f.renewals, 1); assert.equal(f.sent.length, 2); assert.equal(f.usage.state.status, 'expired');
});

test('failed renewal observes its cooldown, then retries', async () => {
  const f = fixture({ auth: old, renew: false });
  await f.usage.refresh(); await f.usage.refresh();
  assert.equal(f.renewals, 1); assert.equal(f.sent.length, 0); assert.equal(f.usage.state.status, 'expired');
  f.advance(5 * 60000); await f.usage.refresh(); assert.equal(f.renewals, 2);
  f.setAuth(fresh); await f.usage.refresh(); assert.equal(f.usage.state.status, 'ok');
});

test('parallel refreshes share one renewal and one request', async () => {
  const f = fixture({ auth: old }); const first = f.usage.refresh(), second = f.usage.refresh();
  assert.equal(first, second); await Promise.all([first, second]);
  assert.equal(f.renewals, 1); assert.equal(f.sent.length, 1);
});

test('disabled usage and missing credentials never start renewal', async () => {
  await new ClaudeUsage({ cacheFile: null, enabled: () => false, readCredentials: async () => assert.fail('Disabled') }).refresh();
  const f = fixture({ auth: null }); await f.usage.refresh();
  assert.equal(f.usage.state.status, 'signedOut'); assert.equal(f.renewals, 0); assert.equal(f.sent.length, 0);
});

test('an unstarted window shows its full duration until it starts', () => {
  assert.equal(untilText(null, NOW, SESSION_MS), '5h');
  assert.equal(untilText(null, NOW + 3600000, SESSION_MS), '5h');
  assert.equal(untilText(null, NOW, WEEK_MS), '7d');
  assert.equal(untilText(NOW + 90 * 60000, NOW, SESSION_MS), '1.5h');
  assert.equal(untilText(null, NOW), '–');
});

function fakeCLI(onInit) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 1);
  const messages = [];
  child.stdin.on('data', data => { messages.push(JSON.parse(data.toString())); onInit?.(child); });
  child.stdin.on('finish', () => child.emit('close', 0));
  return { child, messages };
}
const helperOptions = child => ({ findExecutable: async () => '/test/claude', spawnProcess: () => child, pollMs: 1, timeoutMs: 100 });

test('SDK initialization sends no prompt and waits for saved credentials before EOF', async () => {
  let reads = 0, finishedAt = 0, cwd;
  const { child, messages } = fakeCLI(c => {
    c.stdout.write('{"type":"control_response","response":');
    c.stdout.write('{"subtype":"success","request_id":"macthing-auth-init"}}\n');
  });
  child.stdin.on('finish', () => { finishedAt = reads; });
  const result = await renewClaudeCredentials(async () => ++reads >= 5 ? fresh : old, old, {
    ...helperOptions(child), spawnProcess: (file, args, opts) => {
      assert.equal(file, '/test/claude'); assert.deepEqual(args, AUTH_ARGS);
      assert.ok(args.includes('--no-session-persistence')); assert.ok(args.includes('{"disableAllHooks":true}'));
      assert.equal(opts.env.ANTHROPIC_API_KEY, undefined); assert.equal(opts.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      cwd = opts.cwd; return child;
    },
  });
  assert.equal(result, true); assert.ok(finishedAt >= 5);
  assert.deepEqual(messages, [{ type: 'control_request', request_id: 'macthing-auth-init', request: { subtype: 'initialize', hooks: {} } }]);
  await assert.rejects(fs.stat(cwd), { code: 'ENOENT' });
});

test('a missing CLI and an already-renewed credential need no subprocess', async () => {
  assert.equal(await renewClaudeCredentials(async () => old, old, {
    findExecutable: async () => null, spawnProcess: () => assert.fail('Missing CLI'),
  }), false);
  assert.equal(await renewClaudeCredentials(async () => fresh, old, {
    findExecutable: async () => assert.fail('Already renewed'),
  }), true);
});

test('initialization errors close the child without exposing its output', async () => {
  const { child, messages } = fakeCLI(c => {
    c.stderr.write('private diagnostic that must not be logged');
    c.stdout.write('{"type":"control_response","response":{"subtype":"error","request_id":"macthing-auth-init"}}\n');
  });
  assert.equal(await renewClaudeCredentials(async () => old, old, helperOptions(child)), false);
  assert.equal(child.stdin.writableEnded, true); assert.equal(messages.length, 1);
});

test('stalled initialization times out and closes cleanly', async () => {
  const { child } = fakeCLI();
  assert.equal(await renewClaudeCredentials(async () => old, old, { ...helperOptions(child), timeoutMs: 10 }), false);
  assert.equal(child.stdin.writableEnded, true);
});

test('429 waits at least five minutes and reopening does not bypass the cooldown', async () => {
  const f = fixture({ status: n => n === 1 ? 429 : 200 });
  await f.usage.refresh();
  assert.deepEqual(f.usage.state, {status:'rateLimited',retryAt:NOW+5*60000});
  f.advance(60000); await f.usage.ask(); await f.usage.refresh();
  assert.equal(f.sent.length,1); assert.equal(f.renewals,0);
  f.advance(4*60000); await f.usage.refresh();
  assert.equal(f.sent.length,2); assert.equal(f.usage.state.status,'ok');
});

test('Retry-After seconds and dates are respected, including zero and invalid hints', async () => {
  for (const [hint,delay] of [['900',15*60000],[new Date(NOW+20*60000).toUTCString(),20*60000],['0',5*60000],['bad',5*60000]]) {
    let calls=0;
    const usage=new ClaudeUsage({cacheFile:null,now:()=>NOW,readCredentials:async()=>fresh,
      renewCredentials:async()=>assert.fail('Throttling must not renew the login'),
      fetch:async()=>{calls++;return {...response(429),headers:new Headers({'retry-after':hint})}}});
    await usage.refresh();await usage.refresh();
    assert.equal(usage.state.retryAt,NOW+delay);assert.equal(calls,1);
  }
});

test('repeated throttling backs off, retains marked readings, and resets after recovery', async () => {
  const f=fixture({status:n=>[1,4].includes(n)?200:429});
  await f.usage.refresh();const original=f.usage.state;
  f.advance(5*60000);await f.usage.refresh();
  assert.equal(f.usage.state.stale,true);assert.equal(f.usage.state.updatedAt,original.updatedAt);
  assert.equal(f.usage.state.retryAt,NOW+10*60000);
  f.advance(5*60000);await f.usage.refresh();assert.equal(f.usage.state.retryAt,NOW+20*60000);
  f.advance(10*60000);await f.usage.refresh();assert.equal(f.usage.state.stale,undefined);
  f.advance(5*60000);await f.usage.refresh();assert.equal(f.usage.state.retryAt,NOW+30*60000);
});

test('cached readings and retry cooldown survive restart without storing credentials', async () => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'macthing-usage-cache-'));
  const file=path.join(folder,'cache.json');let now=NOW,calls=0;
  const options={cacheFile:file,now:()=>now,readCredentials:async()=>fresh,
    fetch:async()=>response(++calls===1?200:429)};
  try {
    const first=new ClaudeUsage(options);await first.refresh();
    const justRestarted=new ClaudeUsage(options);await justRestarted.refresh();assert.equal(calls,1,'Restart reuses a just-fetched reading');
    const unreadable=new ClaudeUsage({...options,readCredentials:async()=>{throw new Error('Test Keychain unavailable')}});
    await unreadable.refresh();assert.equal(unreadable.state.status,'error');assert.equal(unreadable.state.session,undefined);
    now+=5*60000;await first.refresh();
    const raw=await fs.readFile(file,'utf8');
    assert(!raw.includes(fresh.accessToken));assert(!raw.includes('refreshToken'));
    const restarted=new ClaudeUsage(options);await restarted.refresh();
    assert.equal(calls,2);assert.equal(restarted.state.status,'ok');assert.equal(restarted.state.stale,true);
    assert.equal(restarted.state.retryAt,NOW+10*60000);assert.equal(restarted.state.session.percent,28);
    const other=new ClaudeUsage({...options,readCredentials:async()=>({...fresh,accessToken:'different-account-token'})});
    await other.refresh();assert.equal(other.state.status,'rateLimited');assert.equal(other.state.session,undefined);
  } finally {await fs.rm(folder,{recursive:true,force:true})}
});

test('a cached window past its reset is not displayed as current usage', async () => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'macthing-usage-cache-'));
  const file=path.join(folder,'cache.json');let now=NOW,calls=0;
  const options={cacheFile:file,now:()=>now,readCredentials:async()=>fresh,fetch:async()=>{
    if(++calls>1)return response(429);
    return {...response(),json:async()=>({five_hour:{utilization:30,resets_at:new Date(NOW+60000).toISOString()},seven_day:{utilization:40,resets_at:null}})};
  }};
  try{
    await new ClaudeUsage(options).refresh();now+=2*60000;
    const restarted=new ClaudeUsage(options);await restarted.refresh();
    assert.equal(restarted.state.status,'rateLimited');assert.equal(restarted.state.session,undefined);
  }finally{await fs.rm(folder,{recursive:true,force:true})}
});

test('transient request failure preserves marked last-known usage and clears after recovery', async () => {
  let now=NOW,calls=0;
  const usage=new ClaudeUsage({cacheFile:null,now:()=>now,readCredentials:async()=>fresh,fetch:async()=>{
    if(++calls===2)throw new Error('Test network failure');return response();
  }});
  await usage.refresh();now+=5*60000;await usage.refresh();
  assert.equal(usage.state.stale,true);assert.equal(usage.state.updatedAt,NOW);
  now+=5*60000;await usage.refresh();assert.equal(usage.state.stale,undefined);
});

test('usage messages identify each provider, including loading and throttling', () => {
  for(const provider of ['bottlerocket','chatgpt']){
    const name=provider==='bottlerocket'?'Bottlerocket':'ChatGPT';
    for(const status of ['loading','error','rateLimited']){
      const m=usageMessage({status,retryAt:NOW+5*60000},provider,NOW);
      assert(m.title.includes(name));
      if(status==='rateLimited')assert.match(m.detail,/Retrying in 5m/);
    }
  }
  assert.equal(usageAge(NOW-4*60000,NOW),'4m ago');
});


test('update age appears only after ten minutes since a successful reading', () => {
  for(const age of [0,1,5,9.99]) assert.equal(usageUpdatedText({status:'ok',updatedAt:NOW-age*60000},NOW),'');
  assert.equal(usageUpdatedText({status:'ok',updatedAt:NOW-10*60000},NOW),'10m ⟳');
  assert.equal(usageUpdatedText({status:'ok',updatedAt:NOW-20*60000,stale:true},NOW),'20m ⟳');
  assert.equal(usageUpdatedText({status:'error',updatedAt:NOW-20*60000},NOW),'');
  assert.equal(usageUpdatedText({status:'ok'},NOW),'');
});
