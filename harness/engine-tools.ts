import type { ToolSchema } from './types.ts';

// The six engine calls as Tony sees them (docs/engine-design.md, playbook "Your tools").
// Tony never passes a token or a session id.
export const ENGINE_TOOLS: ToolSchema[] = [
  {
    name: 'job_open',
    description:
      'Start a release job or join one. Workflow is desktop-release. Target is the version being released. Intent is join, replace or queue. Role is request, side or qa.',
    input_schema: {
      type: 'object',
      properties: {
        workflow: { type: 'string' },
        target: { type: 'string' },
        thread: { type: 'string' },
        role: { type: 'string', enum: ['request', 'side', 'qa'] },
        private: { type: 'boolean' },
        intent: { type: 'string', enum: ['join', 'replace', 'queue'] },
      },
      required: ['workflow', 'target', 'thread', 'intent'],
    },
  },
  {
    name: 'job_view',
    description: 'Read-only briefing for a job or a thread. Never refused.',
    input_schema: {
      type: 'object',
      properties: { job: { type: 'string' }, thread: { type: 'string' } },
    },
  },
  {
    name: 'intend',
    description:
      'Say what you are about to do, before you do it. Actions: open_bump_pr, merge_pr, approve_qa_gate, verify_qa, publish_prod_alpha, verify_served, complete_release_issue.',
    input_schema: {
      type: 'object',
      properties: {
        job: { type: 'string' },
        action: {
          type: 'string',
          enum: [
            'open_bump_pr',
            'merge_pr',
            'approve_qa_gate',
            'verify_qa',
            'publish_prod_alpha',
            'verify_served',
            'complete_release_issue',
          ],
        },
        ref: { type: 'string' },
        because: { type: 'string' },
      },
      required: ['job', 'action', 'ref'],
    },
  },
  {
    name: 'say',
    description: 'Claim a message before you post it yourself with slack_post.',
    input_schema: {
      type: 'object',
      properties: { job: { type: 'string' }, thread: { type: 'string' }, milestone: { type: 'string' } },
      required: ['job', 'thread', 'milestone'],
    },
  },
  {
    name: 'promise_add',
    description: 'Remember a "tell me when" for a milestone. A fallback time is required.',
    input_schema: {
      type: 'object',
      properties: {
        job: { type: 'string' },
        thread: { type: 'string' },
        about: { type: 'string' },
        fallback_time: { type: 'string', description: 'ISO time or a duration such as 4h' },
      },
      required: ['job', 'thread', 'about', 'fallback_time'],
    },
  },
  {
    name: 'checkpoint',
    description:
      'Commit your state and set the next wake. status is one of: working, waiting, blocked, done, cancelled (exactly one of these words; put the sentence in waiting_for). operations: [{ref, action, outcome: done|failed|unknown, note}]. reached: milestone ids you saw happen.',
    input_schema: {
      type: 'object',
      properties: {
        job: { type: 'string' },
        status: { type: 'string', enum: ['working', 'waiting', 'blocked', 'done', 'cancelled'] },
        waiting_for: { type: 'string' },
        next_wake_in: { type: 'string', description: 'for example 5m or 2h' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              action: { type: 'string' },
              outcome: { type: 'string', enum: ['done', 'failed', 'unknown'] },
              note: { type: 'string' },
            },
            required: ['ref', 'outcome'],
          },
        },
        reached: { type: 'array', items: { type: 'string' } },
      },
      required: ['job', 'status'],
    },
  },
];

export const ENGINE_TOOL_NAMES = ENGINE_TOOLS.map((t) => t.name);
