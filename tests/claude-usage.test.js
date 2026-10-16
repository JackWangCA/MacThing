import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { ClaudeUsage } from '../bridge/widgets/usage.js';
import { AUTH_ARGS, renewClaudeCredentials } from '../bridge/widgets/claude-auth.js';
import { SESSION_MS, WEEK_MS, untilText } from '../ui/src/usage.js';

const NOW = 1800000000000;
const old = { accessToken: 'expired-test-token', expiresAt: 1 };
const fresh = { accessToken: 'fresh-test-token', expiresAt: NOW + 3600000 };
const response = (status = 200) => ({ status, ok: status === 200, json: async () => ({
  five_hour: { utilization: 28, resets_at: null }, seven_day: { utilization: 42, resets_at: '2027-02-01T00:00:00Z' },
}) });

function fixture({ auth = fresh, status = () => 200, renew = true } = {}) {
  let now = NOW, reads = 0, renewals = 0;
  const sent = [];
  const usage = new ClaudeUsage({ now: () => now, readCredentials: async () => { reads++; return auth; },
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
  const usage = new ClaudeUsage({ now: () => NOW,
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
  await new ClaudeUsage({ enabled: () => false, readCredentials: async () => assert.fail('Disabled') }).refresh();
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
