import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/background/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const source = bundle.outputFiles[0].text;
const provider = { id: 'proxy', name: 'Proxy', baseUrl: 'http://localhost:20128/v1', apiKey: 'test', model: 'kr/model', headers: {}, quotaAccountId: 'account', quotaAccountName: 'Test' };

async function refresh(payload) {
  let listener, stored = {};
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onConnect: event, onMessage: { addListener(fn) { listener = fn; } } },
    commands: { onCommand: event }, contextMenus: { onClicked: event },
    storage: { local: { get: async () => structuredClone(stored), set: async data => { stored = structuredClone(data); } } }
  };
  vm.runInNewContext(source, {
    chrome, URL, console,
    fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:20128/api/usage/account');
      assert.equal(options.credentials, 'include');
      return Response.json(payload);
    }
  });
  const result = await new Promise(resolve => listener({ type: 'REFRESH_PROVIDER_USAGE_FOR_PROVIDER', provider }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(structuredClone(result.usage), stored.aiVietnameseTranslatorState.usageCache.proxy);
  return result.usage;
}

const currentResponse = {
  plan: 'free', limitReached: false, reviewLimitReached: false, sparkLimitReached: false,
  resetCredits: { availableCount: 0 },
  quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: '2026-11-16T21:06:27.000Z', unlimited: false } }
};

test('current proxy response reads session quota past reset-credit metadata and persists it', async () => {
  const usage = await refresh(currentResponse);
  assert.equal(usage.usage, 1);
  assert.equal(usage.limit, 100);
  assert.equal(usage.remaining, 99);
  assert.equal(usage.percent, 1);
  assert.equal(usage.resetAt, Date.parse(currentResponse.quotas.session.resetAt));
});

test('session quota takes priority over other credit balances and windows', async () => {
  const usage = await refresh({ remaining: 500, ...currentResponse, quotas: { review: { used: 90, total: 100 }, ...currentResponse.quotas } });
  assert.equal(usage.usage, 1);
  assert.equal(usage.remaining, 99);
});

test('nested legacy responses skip metadata and object-valued usage wrappers', async () => {
  const usage = await refresh({ metadata: { plan: 'free' }, data: [{ usage: { used: '0', limit: '100', remaining: '100' } }] });
  assert.equal(usage.usage, 0);
  assert.equal(usage.limit, 100);
  assert.equal(usage.percent, 0);
});

test('flat legacy usage responses remain supported', async () => {
  const usage = await refresh({ used: 25, limit: 100, remaining: 75, resetAt: 1794863187 });
  assert.equal(usage.usage, 25);
  assert.equal(usage.percent, 25);
  assert.equal(usage.resetAt, 1794863187000);
});
