import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/background/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const source = bundle.outputFiles[0].text;
const clone = value => structuredClone(value);
const event = () => { const handlers = []; return { addListener: fn => handlers.push(fn), emit: (...args) => Promise.all(handlers.map(fn => fn(...args))) }; };
function harness({ mode = 'quick', cacheEnabled = true, responseText = 'đường dẫn xử lý', detailsGate, failDetails = 0 } = {}) {
  let state = { providers: [{ id: 'test', name: 'Test', apiKey: 'local-test', baseUrl: 'https://translator.invalid/v1', model: 'original-model', headers: {} }], activeProviderId: 'test', preferences: { translationMode: mode, tone: 'simple', customPrompt: '', timeoutMs: 5000, showFloatingButton: true, cacheEnabled }, glossary: [], history: [], cache: {}, proxyQuotaAccounts: [], usageCache: {} };
  const requests = [], injected = [];
  const onMessage = event(), onConnect = event();
  const chrome = {
    runtime: { onInstalled: event(), onMessage, onConnect }, commands: { onCommand: event() }, contextMenus: { onClicked: event(), create: () => {} },
    tabs: { query: async () => [{id:11},{id:22},{}] },
    scripting: { executeScript: async options => { injected.push(options); if(options.target.tabId === 22) throw new Error("Tab unavailable"); } },
    storage: { local: { get: async () => ({ aiVietnameseTranslatorState: clone(state) }), set: async data => { await new Promise(resolve => setTimeout(resolve, 1)); state = clone(data.aiVietnameseTranslatorState); } } }
  };
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.stream) {
      const content = `data: ${JSON.stringify({ choices: [{ delta: { content: responseText } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(content, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (detailsGate) await detailsGate;
    if (failDetails-- > 0) return new Response("Temporary error", { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translation: 'không được ghi đè bản dịch nhanh', explanation: 'Trong bài kỹ thuật, pipeline là chuỗi bước xử lý.', terms: [{ source: 'pipeline', meaning: 'chuỗi bước xử lý' }] }) } }] });
  };
  vm.runInNewContext(source, { chrome, fetch, crypto: webcrypto, TextEncoder, TextDecoder, AbortController, URL, Response, console, setTimeout, clearTimeout });
  const send = message => new Promise(resolve => onMessage.emit(message, {}, resolve));
  const stream = (text, context, abortOnChunk = false) => new Promise(resolve => {
    const messages = [], incoming = event(), disconnected = event();
    const port = { name: 'translation-stream', onMessage: incoming, onDisconnect: disconnected,
      postMessage: message => { messages.push(clone(message)); if (message.type === 'STREAM_CHUNK' && abortOnChunk) disconnected.emit(); if (['STREAM_DONE','STREAM_ERROR'].includes(message.type)) resolve({ ...message, messages }); }
    };
    onConnect.emit(port); incoming.emit({ type: 'TRANSLATE_STREAM', text, context, translationMode: 'quick' });
  });
  return { send, stream, requests, injected, install: () => chrome.runtime.onInstalled.emit(), state: () => clone(state) };
}

test('quick translation makes one request; details are lazy, deduplicated and preserve the translation', async () => {
  const app = harness();
  const quick = await app.stream('pipeline', 'The data pipeline handles events.');
  assert.equal(quick.type, 'STREAM_DONE'); assert.equal(app.requests.length, 1);
  assert.equal(quick.result.detailsLoaded, false); assert.equal(quick.result.explanation, '');
  assert.ok(!quick.messages.some(message => message.type === 'STREAM_EXPLANATION_START'));
  const [a,b] = await Promise.all([app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId }), app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId })]);
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(app.requests.length, 2);
  assert.equal(a.result.translation, quick.result.translation); assert.equal(a.result.detailsLoaded, true);
  const input = JSON.parse(app.requests[1].messages[1].content);
  assert.equal(input.existingTranslation, quick.result.translation); assert.equal(input.surroundingContext, 'The data pipeline handles events.');
  await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId }); assert.equal(app.requests.length, 2);
  const repeated = await app.stream('pipeline', 'The data pipeline handles events.');
  assert.equal(repeated.cached, true); assert.equal(repeated.result.detailsLoaded, true); assert.equal(app.requests.length, 2);
});

test('context participates in cache identity and is bounded before sending', async () => {
  const app = harness();
  await app.stream('pipeline', 'Data processing'); await app.stream('pipeline', 'Water infrastructure');
  assert.equal(app.requests.length, 2);
  await app.stream('pipeline', 'Data processing'); assert.equal(app.requests.length, 2);
  await app.stream('pipeline', 'x'.repeat(4000));
  assert.equal(JSON.parse(app.requests[2].messages[1].content).surroundingContext.length, 2400);
  assert.match(app.requests[0].messages[0].content, /chỉ dịch sourceText/);
});

test('turning context off omits it from the request and uses a separate cache entry', async () => {
  const app = harness();
  await app.stream('return', 'The Go function returns an error.');
  await app.stream('return', undefined);
  assert.equal(app.requests.length, 2);
  assert.equal(JSON.parse(app.requests[0].messages[1].content).surroundingContext, 'The Go function returns an error.');
  assert.equal(Object.hasOwn(JSON.parse(app.requests[1].messages[1].content), 'surroundingContext'), false);
  await app.stream('return', 'The Go function returns an error.');
  await app.stream('return', undefined);
  assert.equal(app.requests.length, 2);
});

test('word translation receives grammar guidance and preserves the containing sentence', async () => {
  const app = harness();
  const sentence = 'Import the errors package so you can use its errors.New function.';
  await app.stream('so', sentence);
  const request = app.requests[0];
  assert.deepEqual(JSON.parse(request.messages[1].content), { sourceText: 'so', surroundingContext: sentence });
  assert.match(request.messages[0].content, /vai trò ngữ pháp/);
  assert.match(request.messages[0].content, /Không thêm hành động/);
  assert.match(request.messages[0].content, /tùy ngữ cảnh/);
});

test('lazy details use the original model and preferences after settings change', async () => {
  const app = harness(); const quick = await app.stream('pipeline', 'Engineering');
  const current = app.state();
  await app.send({ type: 'SAVE_STATE', state: { providers: [{ ...current.providers[0], model: 'new-model' }], preferences: { ...current.preferences, tone: 'technical' } } });
  await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId });
  assert.equal(app.requests[1].model, 'original-model'); assert.match(app.requests[1].messages[0].content, /Tone: Dễ hiểu/);
});

test('simultaneous paragraph translations retain every history and cache entry', async () => {
  const app = harness(); await Promise.all(['one','two','three','four'].map(text => app.stream(text, 'shared context')));
  assert.equal(app.state().history.length, 4); assert.equal(Object.keys(app.state().cache).length, 4);
});

test('disabled cache stays empty; full mode remains a single complete request', async () => {
  const app = harness({ cacheEnabled: false }); const quick = await app.stream('text');
  await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId }); assert.equal(Object.keys(app.state().cache).length, 0);
  const full = harness({ mode: 'full' }); const response = await full.send({ type: 'TRANSLATE_SELECTION', text: 'text' });
  assert.equal(response.result.detailsLoaded, true); assert.equal(full.requests.length, 1); assert.equal(full.requests[0].stream, false);
  await full.send({ type: 'EXPLAIN_TRANSLATION', historyId: response.historyId }); assert.equal(full.requests.length, 1);
});

test('a deleted history item is not recreated by an in-flight explanation', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = harness({ detailsGate: gate }); const quick = await app.stream('pipeline');
  const explanation = app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId });
  // Wait for the actual request to reach the controlled provider.
  while (app.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  await app.send({ type: 'DELETE_HISTORY_ITEM', id: quick.historyId }); release();
  await explanation; assert.equal(app.state().history.length, 0);
});

test('empty and cancelled streams do not save misleading completed translations', async () => {
  const empty = harness({ responseText: '' }); const response = await empty.stream('text');
  assert.equal(response.type, 'STREAM_ERROR'); assert.equal(empty.state().history.length, 0);
  const cancelled = harness(); const aborted = await cancelled.stream('text', undefined, true);
  assert.equal(aborted.type, 'STREAM_ERROR'); assert.equal(cancelled.state().history.length, 0);
});

test('failed explanations can be retried without changing the completed quick translation', async () => {
  const app = harness({ failDetails: 1 }); const quick = await app.stream('pipeline');
  const failed = await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId });
  assert.equal(failed.ok, false); assert.match(failed.error, /503/);
  assert.equal(app.state().history[0].result.detailsLoaded, false);
  const retried = await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId });
  assert.equal(retried.ok, true); assert.equal(retried.result.translation, quick.result.translation);
});

test('changing the endpoint does not silently send old context to a different provider', async () => {
  const app = harness(); const quick = await app.stream('pipeline');
  await app.send({ type: 'SAVE_STATE', state: { providers: [{ ...app.state().providers[0], baseUrl: 'https://different.invalid/v1' }] } });
  const response = await app.send({ type: 'EXPLAIN_TRANSLATION', historyId: quick.historyId });
  assert.equal(response.ok, false); assert.equal(app.requests.length, 1);
});

test('extension install/update injects content UI into already-open tabs and tolerates unavailable tabs', async () => {
  const app = harness(); await app.install();
  assert.equal(app.injected.length, 2);
  assert.deepEqual(app.injected.map(options => options.target.tabId), [11, 22]);
  assert.ok(app.injected.every(options => options.files[0] === 'content.js'));
});


test('clearing history also removes cached source text and the last translation',async()=>{
  const app=harness();await app.stream('private selection','private context');
  assert.ok(app.state().history.length);assert.ok(Object.keys(app.state().cache).length);
  await app.send({type:'CLEAR_HISTORY'});
  assert.deepEqual(app.state().history,[]);assert.deepEqual(app.state().cache,{});assert.equal(app.state().lastTranslation,undefined);
});
test('public HTTP providers are rejected before transmitting credentials',async()=>{
  const app=harness();
  const response=await app.send({type:'TEST_PROVIDER',provider:{...app.state().providers[0],baseUrl:'http://translator.invalid/v1'}});
  assert.equal(response.ok,false);assert.match(response.error,/HTTPS/);assert.equal(app.requests.length,0);
});
test('missing optional cookie permission does not crash local proxy authentication checks',async()=>{
  const app=harness();
  const response=await app.send({type:'CHECK_LOCAL_PROXY_AUTH_COOKIE',provider:{...app.state().providers[0],baseUrl:'http://127.0.0.1:20128/v1'}});
  assert.equal(response.ok,false);assert.match(response.error,/Chưa được phép/);
});
