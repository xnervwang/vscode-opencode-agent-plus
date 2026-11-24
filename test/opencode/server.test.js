// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findOpenCode, acpLaunch, parseVersion, mergeConfigContent, OpenCodeError } = require('../../src/opencode/server');

const v1 = { major: 1, minor: 19, patch: 6, text: '1.19.6' };
const v2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };

test('the configured path wins, then PATH, then the installers\' locations', () => {
  const home = '/home/u';
  const env = { PATH: ['/usr/bin', '/opt/tools'].join(path.delimiter) };
  const version = () => v1;
  const has = (set) => (p) => set.includes(p);
  assert.equal(findOpenCode({ configured: '~/bin/oc', env, home, platform: 'linux', isExecutable: has(['/home/u/bin/oc', '/opt/tools/opencode']), readVersion: version }).path, '/home/u/bin/oc');
  assert.equal(findOpenCode({ env, home, platform: 'linux', isExecutable: has(['/opt/tools/opencode', '/home/u/.opencode/bin/opencode']), readVersion: version }).path, '/opt/tools/opencode');
  const r = findOpenCode({ env, home, platform: 'linux', isExecutable: has(['/home/u/.opencode/bin/opencode']), readVersion: version });
  assert.equal(r.path, '/home/u/.opencode/bin/opencode');
  assert.deepEqual(r.version, v1);
});

test('not found, or a configured path that is not there, says how to install', () => {
  const opts = { env: { PATH: '' }, home: '/h', platform: 'linux', isExecutable: () => false, readVersion: () => null };
  assert.throws(() => findOpenCode(opts), (e) => e instanceof OpenCodeError && e.code === 'notFound' && /opencode\.ai\/install/.test(e.message));
  assert.throws(() => findOpenCode({ ...opts, configured: '/nope/opencode' }), (e) => e.code === 'configuredNotFound' && e.message.includes('/nope/opencode'));
});

test('1.x runs `acp` on 127.0.0.1 with a password and the 1.x permission keys', () => {
  const l = acpLaunch({ bin: '/b/opencode', version: v1, env: { AWS_PROFILE: 'p' }, baseEnv: { PATH: '/usr/bin' } });
  assert.deepEqual(l.args, ['acp', '--hostname', '127.0.0.1']);
  assert.equal(l.env.AWS_PROFILE, 'p');
  assert.equal(l.env.PATH, '/usr/bin');
  assert.ok(l.env.OPENCODE_SERVER_PASSWORD.length >= 32);
  const cfg = JSON.parse(l.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask', question: 'deny' });
  assert.notEqual(acpLaunch({ bin: 'b', version: v1, baseEnv: {} }).env.OPENCODE_SERVER_PASSWORD, l.env.OPENCODE_SERVER_PASSWORD);
});

test('2.x runs `acp` with the 2.x permission rules; permissions: false adds none', () => {
  const l = acpLaunch({ bin: 'b', version: v2, baseEnv: {} });
  assert.deepEqual(l.args, ['acp']);
  const cfg = JSON.parse(l.env.OPENCODE_CONFIG_CONTENT);
  assert.ok(cfg.permissions.some((r) => r.action === 'shell' && r.effect === 'ask'));
  assert.equal(acpLaunch({ bin: 'b', version: v2, baseEnv: {}, permissions: false }).env.OPENCODE_CONFIG_CONTENT, undefined);
});

test('config content the user already passes keeps its own keys', () => {
  const merged = JSON.parse(mergeConfigContent('{"permission":{"bash":"allow"},"model":"x/y"}', { permission: { bash: 'ask' }, extra: 1 }));
  assert.deepEqual(merged, { permission: { bash: 'allow' }, model: 'x/y', extra: 1 });
  assert.deepEqual(JSON.parse(mergeConfigContent('not json', { a: 1 })), { a: 1 });
});

test('versions are read from either line\'s --version output', () => {
  assert.deepEqual(parseVersion('1.19.6\n'), v1);
  assert.deepEqual(parseVersion('opencode v2.4.1'), v2);
  assert.equal(parseVersion(''), null);
});

test('autoupdate is always off', () => {
  assert.equal(acpLaunch({ bin: 'b', version: v1, baseEnv: {} }).env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(acpLaunch({ bin: 'b', version: v2, baseEnv: {}, permissions: false }).env.OPENCODE_DISABLE_AUTOUPDATE, '1');
});

test('extra config merges over ours: objects key by key, arrays appended', () => {
  const l1 = acpLaunch({ bin: 'b', version: v1, baseEnv: {}, config: { plugin: ['file:///p/index.js'], permission: { external_directory: { '*': 'ask', '/plans/**': 'allow' } } } });
  const c1 = JSON.parse(l1.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(c1.plugin, ['file:///p/index.js']);
  assert.deepEqual(c1.permission.external_directory, { '*': 'ask', '/plans/**': 'allow' });
  assert.equal(c1.permission.bash, 'ask');
  const l2 = acpLaunch({ bin: 'b', version: v2, baseEnv: {}, config: { plugins: ['/p'], permissions: [{ action: 'external_directory', resource: '/plans/**', effect: 'allow' }] } });
  const c2 = JSON.parse(l2.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(c2.plugins, ['/p']);
  assert.deepEqual(c2.permissions[c2.permissions.length - 1], { action: 'external_directory', resource: '/plans/**', effect: 'allow' });
  const l3 = acpLaunch({ bin: 'b', version: v1, baseEnv: {}, permissions: false, config: { plugin: ['file:///p/index.js'] } });
  assert.deepEqual(JSON.parse(l3.env.OPENCODE_CONFIG_CONTENT), { plugin: ['file:///p/index.js'] });
});

test('the question tool is turned off unless the OpenCode found is 2.4.1 or later', () => {
  const { permissionConfig, asksQuestions } = require('../../src/opencode/server');
  const off = (cfg) => (cfg.permissions ? cfg.permissions.some((r) => r.action === 'question' && r.effect === 'deny') : cfg.permission.question === 'deny');
  const at = (text) => parseVersion(text);
  for (const t of ['2.4.1', '2.4.2', '2.5.0', '2.10.0', '3.0.0']) {
    assert.equal(asksQuestions(at(t)), true, t);
    assert.equal(off(permissionConfig(at(t))), false, `${t} asks through forms`);
  }
  for (const t of ['2.0.0', '2.3.9', '2.4.0', '1.19.6']) {
    assert.equal(asksQuestions(at(t)), false, t);
    assert.equal(off(permissionConfig(at(t))), true, `${t} keeps the tool off`);
  }
  assert.equal(off(permissionConfig(2)), true, 'a bare major says too little');
  assert.equal(off(permissionConfig(null)), true);
  const launched = (v) => JSON.parse(acpLaunch({ bin: 'b', version: v, baseEnv: {} }).env.OPENCODE_CONFIG_CONTENT);
  assert.equal(launched(v2).permissions.some((r) => r.action === 'question'), false);
  assert.deepEqual(launched(at('2.3.0')).permissions.at(-1), { action: 'question', resource: '*', effect: 'deny' });
  assert.ok(launched(at('2.3.0')).permissions.some((r) => r.action === 'shell' && r.effect === 'ask'), 'the 2.x dialect still');
  assert.equal(launched(v1).permission.question, 'deny');
});
