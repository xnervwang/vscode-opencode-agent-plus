// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* What the extension says once the sign-in terminal closes, and the credential listing it compares. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginOutcome } = require('../../src/host/provider-login');
const { createOpenCode, parseCredentials } = require('../../src/opencode');
const { fakeStarter } = require('../opencode/fake-agent');

const BEDROCK = [{ id: 'amazon-bedrock/us.xai.grok-4.7', providerId: 'amazon-bedrock' }];
const FREE = [{ id: 'opencode/big-pickle', providerId: 'opencode' }];
const cred = (id, ...ids) => ({ id, name: id === 'amazon-bedrock' ? 'Amazon Bedrock' : id === 'anthropic' ? 'Anthropic' : id, credentials: ids });

test('a credential for a provider with none and no models connects it', () => {
  assert.equal(loginOutcome({ before: [], after: [cred('amazon-bedrock', 'c1')], had: FREE, now: [...FREE, ...BEDROCK] }),
    'Connected Amazon Bedrock. OpenCode offers 2 models.');
});

test('a new credential for a provider already connected says it was saved, not that nothing was added', () => {
  assert.equal(loginOutcome({ before: [cred('amazon-bedrock', 'c1')], after: [cred('amazon-bedrock', 'c1', 'c2')], had: BEDROCK, now: BEDROCK }),
    'Saved new credentials for Amazon Bedrock, which was already connected. OpenCode offers 1 model.');
  assert.match(loginOutcome({ before: [], after: [cred('amazon-bedrock', 'c1')], had: BEDROCK, now: BEDROCK }), /^Saved new credentials for Amazon Bedrock/,
    'a provider whose models were listed through its environment counts as connected already');
  assert.equal(loginOutcome({ before: [cred('amazon-bedrock', 'c1')], after: [cred('amazon-bedrock', 'c1', 'c2'), cred('anthropic', 'c3')], had: BEDROCK, now: BEDROCK }),
    'Connected Anthropic. Saved new credentials for Amazon Bedrock, which was already connected. OpenCode offers 1 model.');
});

test('no new credential means the sign-in closed without saving one', () => {
  assert.equal(loginOutcome({ before: [cred('amazon-bedrock', 'c1')], after: [cred('amazon-bedrock', 'c1')], had: BEDROCK, now: BEDROCK }),
    'The sign-in closed without saving credentials, so nothing changed. OpenCode offers 1 model.');
});

test('without the credential lists only the models are compared, and an unchanged list is not called a failure', () => {
  assert.equal(loginOutcome({ before: null, after: null, had: FREE, now: [...FREE, ...BEDROCK] }), 'OpenCode now offers models from amazon-bedrock.');
  assert.equal(loginOutcome({ before: null, after: [cred('amazon-bedrock', 'c1')], had: BEDROCK, now: BEDROCK }), 'OpenCode restarted and offers 1 model.');
  assert.equal(loginOutcome({ before: null, after: null, had: BEDROCK, now: [] }), 'OpenCode restarted.');
});

test("OpenCode's credential listing keeps each integration's credential ids", () => {
  const out = JSON.stringify([{ id: 'amazon-bedrock', name: 'Amazon Bedrock', connections: [
    { type: 'credential', id: 'cred_a', label: 'Amazon Bedrock', method: 'external' }, { type: 'env', id: 'AWS_PROFILE' }] }]);
  assert.deepEqual(parseCredentials(out), [{ id: 'amazon-bedrock', name: 'Amazon Bedrock', credentials: ['cred_a'] }]);
  assert.deepEqual(parseCredentials('[]'), []);
  assert.equal(parseCredentials('No authenticated integrations'), null);
});

test('credentials() lists them with auth list on OpenCode 2, and is null on OpenCode 1 and when the listing fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-creds-'));
  const run = (version, reply) => {
    const calls = [];
    const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version }), startAcp: fakeStarter().start, idleStopMs: 0,
      execFile: (file, args, opts, cb) => { calls.push(args); const [err, out] = reply; cb(err, out, ''); } });
    return { oc, calls };
  };
  const v2 = run({ major: 2, minor: 4, patch: 1, text: '2.4.1' }, [null, JSON.stringify([{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential', id: 'c' }] }])]);
  assert.deepEqual(await v2.oc.credentials(), [{ id: 'anthropic', name: 'Anthropic', credentials: ['c'] }]);
  assert.deepEqual(v2.calls[0].slice(0, 4), ['auth', 'list', '--format', 'json']);
  assert.equal(await run({ major: 1, minor: 19, patch: 6, text: '1.19.6' }, [null, '[]']).oc.credentials(), null);
  assert.equal(await run({ major: 2, minor: 4, patch: 1, text: '2.4.1' }, [new Error('no'), '']).oc.credentials(), null);
  fs.rmSync(root, { recursive: true, force: true });
});
