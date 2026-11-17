import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWorkflow, workflowTier, matchesImage, hasResourceType } from '../public/js/civitai-logic.js';
import { buildUpstreamUrl } from '../lib/civitai.mjs';

const up = (q) => buildUpstreamUrl(new URL(`http://localhost/api/civitai/images?${q}`)).upstream;

test('ComfyUI UI graph recognized inside JSON string', () => {
  const m = { workflow: JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }], links: [] }) };
  assert.equal(workflowTier(m), 'graph');
  assert.equal(extractWorkflow(m).nodes[0].type, 'KSampler');
});
test('ordinary prompt and sampler are NOT a graph', () => {
  assert.equal(workflowTier({ prompt: 'portrait of a person', seed: 4, sampler: 'Euler' }), 'params');
  assert.equal(extractWorkflow({ prompt: 'not json' }), null);
  assert.equal(workflowTier(null), 'none');
});
test('Civitai comfy field exposes the UI workflow', () => {
  const workflow = { nodes: [{ id: 1, type: 'KSampler' }], links: [] };
  const meta = { workflow: 'txt2img', comfy: JSON.stringify({ prompt: { 1: { class_type: 'KSampler', inputs: {} } }, workflow }) };
  assert.deepEqual(extractWorkflow(meta), workflow);
});
test('resource, block and "my LoRAs" filtering', () => {
  const img = { username: 'Unhelpful', width: 800, height: 1200, stats: { likeCount: 20 }, meta: { prompt: 'sunset', civitaiResources: [{ type: 'lora', modelVersionId: 10 }] } };
  assert.equal(hasResourceType(img, 'lora'), true);
  assert.equal(matchesImage(img, { workflow: 'params', resourceType: 'lora', minLikes: 5, orientation: 'portrait', text: 'sunset' }, new Set()), true);
  assert.equal(matchesImage(img, { workflow: 'all', resourceType: 'all' }, new Set(['unhelpful'])), false);
  assert.equal(matchesImage(img, { workflow: 'all', resourceType: 'mine', ownedVersionIds: new Set([10]) }), true);
  assert.equal(matchesImage(img, { workflow: 'all', resourceType: 'mine', ownedVersionIds: new Set([11]) }), false);
});
test('.red all-permitted explicitly requests mature; explicit rating kept', () => {
  assert.equal(up('site=red').hostname, 'civitai.red');
  assert.equal(up('site=red').searchParams.get('nsfw'), 'true');
  assert.equal(up('site=red&nsfw=Mature').searchParams.get('nsfw'), 'Mature');
});
test('.com stays SFW and junk parameters are dropped', () => {
  const u = up('site=com&nsfw=true&modelId=abc&modelVersionId=22&sort=DROP&evil=1&limit=999');
  assert.equal(u.searchParams.get('nsfw'), 'None');
  assert.equal(u.searchParams.get('modelId'), null);
  assert.equal(u.searchParams.get('modelVersionId'), '22');
  assert.equal(u.searchParams.get('sort'), null);
  assert.equal(u.searchParams.get('evil'), null);
  assert.equal(u.searchParams.get('limit'), '200');
});
