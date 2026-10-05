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
