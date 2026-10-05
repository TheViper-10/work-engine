// R62: the scorer's voice rule, with the live run 2 texts as regression input and different ones as variations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceViolations } from '../harness/score.ts';

test('voice: engine words, bold, checkmarks, issue ids and banned names are each caught', () => {
  assert.deepEqual(voiceViolations('On it, Rashmi', ['Rashmi']), ['addresses Rashmi, who is not the requester']);
  assert.ok(voiceViolations('From my briefing, the home has one in-flight action').length >= 1);
  assert.deepEqual(voiceViolations('**QA is ready** :white_check_mark:'), ['markdown bold', 'checkmark']);
  assert.deepEqual(voiceViolations('Tracked in ISS-65'), ['issue id ISS-65']);
  // variations: another banned name, a unicode checkmark, another engine word
  assert.ok(voiceViolations('Thanks Anil!', ['Anil']).length === 1);
  assert.ok(voiceViolations('✅ merged').includes('checkmark'));
  assert.ok(voiceViolations('I will checkpoint it').length === 1);
});

test('voice: plain words addressed to the Slack author pass', () => {
  assert.deepEqual(voiceViolations('On it, <@U042GEDM4BB>. The release is at QA and I will tell you when it is live.', ['Rashmi']), []);
  assert.deepEqual(voiceViolations('5.2.12 is live on prod alpha.', ['Rashmi']), []);
});

// Harness fidelity (real-model smoke of interruption-boundary): a ts the world showed in slack_read_thread names its thread even when the
// scenario has no root_ts, so a reply by channel + thread_ts is a reply; only a ts no message has is unknown.
import { World } from '../harness/world.ts';
test('world: a shown message ts resolves to its thread; an unknown ts does not', () => {
  const w: any = new World({ initial_world: { github: {}, circleci: {}, slack: {} }, threads: { A: { channel: 'C0C4K4EGZT6', root_ts: null }, B: { channel: 'C0C4K4EGZT6', root_ts: null } }, people: {}, jobs: [] });
  w.addMessage('A', { user: 'U1', text: 'root', ts: '1790907382.000001', tMin: 0 });
  w.addMessage('B', { user: 'U1', text: 'root', ts: '1790908000.000002', tMin: 0 });
  assert.equal(w.resolveThread('C0C4K4EGZT6:1790907382.000001'), 'A');
  assert.equal(w.resolveThread('1790908000.000002'), 'B');
  assert.equal(w.resolveThread('C0C4K4EGZT6:1759651539.000000'), null);
  assert.equal(w.resolveThread('A'), 'A');
});

test('voice: an issue id the requester wrote may be said back; an id they did not write may not', () => {
  assert.deepEqual(voiceViolations('under ISS-37', [], ['ISS-37']), []);
  assert.deepEqual(voiceViolations('tracked in ISS-70', [], ['ISS-37']), ['issue id ISS-70']);
});
