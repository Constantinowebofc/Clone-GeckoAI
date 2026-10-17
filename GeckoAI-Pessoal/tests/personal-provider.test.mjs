import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPersonalProvider } from '../lib/providers.js';
import { normalizeAI, credentialForAI, LOCAL_CREDENTIAL } from '../lib/personal-ai.js';
const base = { baseURL: 'https://api.example.test/v1', model: 'test-model' };
const success = message => Response.json({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const make = fetch => createPersonalProvider({ getConfig: async () => base, fetch });
test('blocks remote plaintext, credentials and query-bearing API URLs', () => {
  for (const baseURL of ['http://api.example.test/v1', 'https://user:pass@api.example.test/v1', 'https://api.example.test/v1?secret=x', 'file:///tmp/x']) assert.throws(() => normalizeAI({ baseURL }));
  assert.equal(normalizeAI({ baseURL: 'http://localhost:11434/v1/' }).baseURL, 'http://localhost:11434/v1');
  assert.throws(() => credentialForAI('', base));
  assert.throws(() => credentialForAI(LOCAL_CREDENTIAL, base));
});
test('validates credentials and selected model without a generation request', async () => {
  const requests = [];
  const provider = make(async (url, init) => { requests.push({ url, init }); return Response.json({ data: [{ id: 'test-model' }] }); });
  const models = await provider.listModels('test-key-not-real');
  assert.deepEqual(models, [{ id: 'test-model', label: 'test-model' }]);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, base.baseURL + '/models');
  assert.equal(requests[0].init.method, 'GET'); assert.equal(requests[0].init.redirect, 'error');
});
test('missing model and unauthorized API access fail with safe errors', async () => {
  await assert.rejects(make(async () => Response.json({ data: [] })).validate('not-real'), /modelo escolhido/);
  await assert.rejects(make(async () => new Response('private provider payload', { status: 401 })).validate('not-real'), /recusou/);
});
test('complete HTTP tool roundtrip preserves context, images and tool results', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    const toolResult = requests.at(-1).body.messages.find(m => m.role === 'tool');
    const message = toolResult ? { role: 'assistant', content: 'Arquivo analisado.' } : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/App.tsx"}' } }] };
    res.end(JSON.stringify({ choices: [{ finish_reason: toolResult ? 'stop' : 'tool_calls', message }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const config = { baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model' };
    const provider = createPersonalProvider({ getConfig: async () => config });
    const key = credentialForAI('', config);
    await provider.validate(key);
    const session = provider.createSession({ apiKey: key, model: config.model, system: 'Inspect this project', tools: [tool] });
    const first = await session.start('Project context', 'Inspect file', [{ mediaType: 'image/png', dataBase64: 'AA==' }]);
    assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'read_file', input: { path: 'src/App.tsx' } }]);
    const final = await session.reply([{ id: 'call_1', output: 'file contents' }]);
    assert.equal(final.text, 'Arquivo analisado.'); assert.deepEqual(final.toolCalls, []);
    assert.equal(requests.length, 3); assert.ok(requests.every(r => r.auth === undefined));
    assert.equal(requests[1].body.messages[0].role, 'system');
    assert.equal(requests[1].body.messages[1].content[1].image_url.url, 'data:image/png;base64,AA==');
    assert.equal(requests[2].body.messages.at(-1).tool_call_id, 'call_1');
    assert.equal(requests[2].body.tools[0].function.name, 'read_file');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
for (const [name, calls] of [
  ['truncated JSON arguments', [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{' } }]],
  ['unknown tool', [{ id: 'a', type: 'function', function: { name: 'not_registered', arguments: '{}' } }]],
  ['duplicate calls', [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }, { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }]],
]) test(`rejects ${name} before returning any tools`, async () => {
  const session = make(async () => success({ role: 'assistant', tool_calls: calls })).createSession({ apiKey: 'test', system: 'test', tools: [tool] });
  await assert.rejects(session.start('', 'test'));
});
test('truncated output is resumable and never returned as an executable call', async () => {
  const provider = make(async () => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'incomplete' } }] }));
  await assert.rejects(provider.createSession({ apiKey: 'test', system: 'test' }).start('', 'test'), e => e.retomavel === true);
});
test('aborting the request propagates to fetch', async () => {
  const controller = new AbortController();
  const provider = make(async (url, init) => { init.signal.throwIfAborted(); return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); });
  const run = provider.validate('test', controller.signal); controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(run, { name: 'AbortError' });
});
test('session rejects mismatched tool results', async () => {
  const calls = [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
  const session = make(async () => success({ role: 'assistant', tool_calls: calls })).createSession({ apiKey: 'test', system: 'test', tools: [tool] });
  await session.start('', 'test'); await assert.rejects(session.reply([{ id: 'wrong', output: '' }]), /pendentes/);
});

test('browser permission match pattern for local API does not include the port', async () => {
  const { requestAIOrigin } = await import('../lib/personal-ai.js');
  const previous = globalThis.chrome;
  let origins;
  globalThis.chrome = { permissions: { request: async value => { origins = value.origins; return true; } } };
  try { await requestAIOrigin({ baseURL: 'http://localhost:11434/v1', model: 'test' }); assert.deepEqual(origins, ['http://localhost/*']); }
  finally { globalThis.chrome = previous; }
});

for (const mode of ['plan', 'build']) test(`existing agent ${mode} workflow uses the personal provider`, async () => {
  const { runAgent } = await import('../lib/agent.js');
  const actions = [
    { name: 'read_file', arguments: { path: 'README.md' } },
    ...(mode === 'build' ? [
      { name: 'edit_file', arguments: { path: 'README.md', old_string: 'before', new_string: 'after' } },
      { name: 'set_commit_message', arguments: { message: 'docs: update README' } },
    ] : []),
  ];
  let index = 0; let committed = null;
  const provider = make(async (url, init) => {
    const body = JSON.parse(init.body);
    if (mode === 'plan') assert.ok(!body.tools.some(t => t.function.name === 'edit_file'));
    const action = actions[index++];
    return action ? success({ role: 'assistant', content: null, tool_calls: [{ id: `step_${index}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }) : success({ role: 'assistant', content: mode === 'build' ? 'README atualizado.' : 'Plano: atualizar README.' });
  });
  const github = {
    getHead: async () => 'base-sha',
    getTree: async () => ({ files: [{ path: 'README.md', sha: 'readme-sha', type: 'blob' }], truncated: false }),
    readFile: async () => 'before\n',
    commitChanges: async (owner, repo, branch, staged) => { committed = new Map(staged); return { sha: 'new-sha', url: 'https://example.test/commit/new-sha' }; },
  };
  const result = await runAgent({ github, provider, apiKey: 'not-real', model: base.model, owner: 'test', repo: 'test', branch: 'main', prompt: 'Update the README', mode }, () => {});
  if (mode === 'plan') { assert.equal(result.commit, null); assert.equal(committed, null); assert.match(result.summary, /Plano/); }
  else { assert.equal(result.commit.sha, 'new-sha'); assert.equal(committed.get('README.md').content, 'after\n'); }
});
