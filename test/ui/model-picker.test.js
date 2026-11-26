// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The model picker's rows: the variants of one Bedrock model across geographies share a row, and the filter keeps
   the variants it matches. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../media/composer.js');

const MODELS = [
  { id: 'amazon-bedrock/us.openai.gpt-5.6-luna', name: 'GPT-5.6 Luna (US)', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/openai.gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/in.openai.gpt-5.6-luna', name: 'GPT-5.6 Luna (India)', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/global.openai.gpt-5.6-luna', name: 'GPT-5.6 Luna (Global)', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/eu.amazon.nova-pro-v1:0', name: 'Nova Pro (EU)', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/apac.amazon.nova-pro-v1:0', name: 'Nova Pro (APAC)', group: 'Amazon Bedrock' },
  { id: 'amazon-bedrock/deepseek.v3.2', name: 'DeepSeek V3.2', group: 'Amazon Bedrock' },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', group: 'Anthropic' },
];
const families = () => C.modelFamilies(MODELS, (m) => m.group);

test('a geography prefix is one only when a vendor and a model follow it', () => {
  assert.deepEqual(C.modelVariant('amazon-bedrock/us.xai.grok-4.7'), { base: 'amazon-bedrock/xai.grok-4.7', geo: 'us', label: 'US' });
  assert.deepEqual(C.modelVariant('amazon-bedrock/us-gov.anthropic.claude-sonnet-5'), { base: 'amazon-bedrock/anthropic.claude-sonnet-5', geo: 'us-gov', label: 'GovCloud' });
  assert.equal(C.modelVariant('amazon-bedrock/deepseek.v3.2').geo, '', 'deepseek is a vendor');
  assert.equal(C.modelVariant('amazon-bedrock/in.openai.gpt-5.6-luna').label, 'India');
  assert.equal(C.modelVariant('anthropic/claude-sonnet-5').label, 'In-Region');
});

test("one model's geographies share a row named without them, the geographies first and the In-Region id last", () => {
  const g = families();
  assert.deepEqual(g.map((x) => x.label), ['Amazon Bedrock', 'Anthropic']);
  const bedrock = g[0].families;
  assert.deepEqual(bedrock.map((f) => f.name), ['DeepSeek V3.2', 'GPT-5.6 Luna', 'Nova Pro']);
  const luna = bedrock.find((f) => f.name === 'GPT-5.6 Luna');
  assert.deepEqual(luna.variants.map((v) => v.label), ['Global', 'US', 'India', 'In-Region']);
  assert.equal(luna.key, 'amazon-bedrock/openai.gpt-5.6-luna');
  const nova = bedrock.find((f) => f.name === 'Nova Pro');
  assert.deepEqual(nova.variants.map((v) => v.label), ['EU', 'APAC'], 'with no In-Region id, the name drops the geography');
});

test('the filter matches names, ids and geographies, and keeps only the variants it matches', () => {
  const only = (q) => C.filterModelFamilies(families(), q).map((g) => [g.label, g.families.map((f) => [f.name, f.variants.map((v) => v.label)])]);
  assert.deepEqual(only('luna india'), [['Amazon Bedrock', [['GPT-5.6 Luna', ['India']]]]]);
  assert.deepEqual(only('NOVA'), [['Amazon Bedrock', [['Nova Pro', ['EU', 'APAC']]]]]);
  assert.deepEqual(only('anthropic'), [['Anthropic', [['Claude Sonnet 5', ['In-Region']]]]], 'the group name counts too');
  assert.deepEqual(only('nothing like this'), []);
  assert.equal(C.filterModelFamilies(families(), '  ').length, 2, 'an empty filter keeps everything');
});
