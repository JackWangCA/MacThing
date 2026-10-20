import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BottlerocketUsage, personalTokens, spendSummary, sumCost, weekBounds, weeklyLimitFor,
} from '../bridge/widgets/bottlerocket-usage.js';

const NOW = Date.UTC(2026, 9, 21, 15, 0, 0); // Wednesday

test('the week starts Monday 00:00 UTC and resets the next Monday', () => {
  const { start, resetsAt } = weekBounds(NOW);
  assert.equal(new Date(start).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(new Date(resetsAt).toISOString(), '2026-10-26T00:00:00.000Z');
});

test('personal tokens prefer coder- notes and otherwise include every token', () => {
  const mixed = [{ token_id: 'a', notes: 'coder-laptop' }, { token_id: 'b', notes: 'sidekick' }];
  assert.deepEqual(personalTokens(mixed).map((t) => t.token_id), ['a']);
  assert.deepEqual(personalTokens([{ token_id: 'b', notes: '' }]).map((t) => t.token_id), ['b']);
});

test('weekly limits add up only for the tokens being shown', () => {
  const limits = { items: [
    { token_id: 'a', spend_policy: { windows: [{ period: 'weekly', limit_usd: 40 }, { period: 'daily', limit_usd: 10 }] } },
    { token_id: 'b', spend_policy: { windows: [{ period: 'weekly', limit_usd: 15 }] } },
    { token_id: 'c', spend_policy: { windows: [{ period: 'monthly', limit_usd: 100 }] } },
  ] };
  assert.equal(weeklyLimitFor(limits, ['a', 'c']), 40);
  assert.equal(weeklyLimitFor(limits, ['c']), null);
});

test('cost rolls up the same way as the tokens site', () => {
  const usage = { results: { xai: [{ total_cost_usd: 1.25 }, { total_cost_usd: 0.5 }], google: [{ total_cost_usd: 2 }] } };
  assert.equal(sumCost(usage), 3.75);
  const summary = spendSummary({
    tokens: [{ token_id: 'a', notes: 'coder-laptop' }],
    limits: { items: [{ token_id: 'a', spend_policy: { windows: [{ period: 'weekly', limit_usd: 10 }] } }] },
    usage, now: NOW,
  });
  assert.equal(summary.spent, 3.75);
  assert.equal(summary.limit, 10);
  assert.equal(summary.percent, 37.5);
  assert.equal(summary.resetsAt, weekBounds(NOW).resetsAt);
});

const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/** A widget with a saved token, in a throwaway folder the caller cleans up. */
async function withToken(token, request, extra = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-br-'));
  const tokenFile = path.join(folder, 'token.json');
  if (token) await fs.writeFile(tokenFile, JSON.stringify({ token }));
  return {
    folder,
    usage: new BottlerocketUsage({ tokenFile, env: {}, now: () => NOW, request, ...extra }),
  };
}

test('a saved token reads this week\u2019s spend against the weekly limit', async () => {
  const calls = [];
  const { folder, usage } = await withToken('br-secret', async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.authorization, 'Bearer br-secret');
    if (url.endsWith('/v2/tokens/me')) return json({ items: [{ token_id: 'a', notes: 'coder-mac' }] });
    if (url.includes('/v2/spend-limits/team')) return json({ items: [{ token_id: 'a', spend_policy: { windows: [{ period: 'weekly', limit_usd: 50 }] } }] });
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.token_ids, ['a']);
    assert.equal(body.use_case, 'personal');
    assert.equal(body.from_timestamp, '2026-10-19T00:00:00.000Z');
    return json({ results: { xai: [{ total_cost_usd: 12.4 }] } });
  });
  try {
    await usage.refresh();
    assert.equal(usage.state.spent, 12.4);
    assert.equal(usage.state.limit, 50);
    assert.equal(usage.state.percent, 24.8);
    assert.equal(calls.length, 3);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('with no token anywhere the clock says so, and never calls Bottlerocket', async () => {
  const { folder, usage } = await withToken(null, async () => {
    throw new Error('should not reach the network without a token');
  });
  try {
    await usage.refresh();
    assert.equal(usage.state.status, 'noToken');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('a token in the environment stands in for one that was never saved', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-br-'));
  const seen = [];
  const usage = new BottlerocketUsage({
    tokenFile: path.join(folder, 'token.json'),
    env: { ANTHROPIC_AUTH_TOKEN: '  from-the-shell  ' }, // trimmed, like a pasted one
    now: () => NOW,
    request: async (url, opts) => {
      seen.push(opts.headers.authorization);
      return json(url.endsWith('/v2/tokens/me') ? { items: [] } : {});
    },
  });
  try {
    await usage.refresh();
    assert.deepEqual(seen, ['Bearer from-the-shell']);
    assert.equal(usage.state.status, 'none', 'the token works; the account just has nothing to count');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('a refused token is reported but kept, so a typo can be seen and corrected', async () => {
  for (const status of [401, 403]) {
    const { folder, usage } = await withToken('wrong', async () => json({ detail: 'nope' }, status));
    try {
      await usage.refresh();
      assert.equal(usage.state.status, 'badToken');
      assert.match(usage.state.detail, new RegExp(String(status)));
      assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'token.json'), 'utf8')).token, 'wrong');
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
});

test('throttling and outages keep the last good reading and say when they will retry', async () => {
  let reply = json({ items: [{ token_id: 'a', notes: 'coder-mac' }] });
  const { folder, usage } = await withToken('br-secret', async (url) => {
    if (url.endsWith('/v2/tokens/me')) return reply;
    if (url.includes('/v2/spend-limits/team')) return json({ items: [] });
    return json({ results: { xai: [{ total_cost_usd: 5 }] } });
  });
  try {
    await usage.refresh();
    assert.equal(usage.state.status, 'ok');
    reply = json({ detail: 'slow down' }, 429);
    await usage.refresh();
    assert.equal(usage.state.spent, 5, 'the last good number stays on screen');
    assert.equal(usage.state.stale, true);
    assert.equal(usage.state.retryAt, NOW + 15 * 60 * 1000, '429 waits longer than an ordinary error');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('setToken saves, replaces and clears, and the file is owner-only', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-br-'));
  const tokenFile = path.join(folder, 'token.json');
  const usage = new BottlerocketUsage({
    tokenFile, env: {}, now: () => NOW, request: async () => json({ items: [] }),
  });
  try {
    await usage.setToken('  first  ');
    assert.equal(JSON.parse(await fs.readFile(tokenFile, 'utf8')).token, 'first', 'trimmed on the way in');
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal(await usage.hasToken(), true);
    await usage.setToken('second');
    assert.equal(JSON.parse(await fs.readFile(tokenFile, 'utf8')).token, 'second');
    await usage.setToken('');
    assert.equal(await usage.hasToken(), false, 'an empty box removes it');
    assert.equal(usage.state.status, 'noToken');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
