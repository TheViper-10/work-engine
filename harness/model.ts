// Tony's brain for replays: a real model through the DevRev AI gateway (D14), or a scripted stand-in.
// The gateway key comes from WE_GATEWAY_KEY and is never printed or logged.

import type { ToolSchema } from './types.ts';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface TonyMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface TonyRequest {
  system: string;
  messages: TonyMessage[];
  tools: ToolSchema[];
}

export interface TonyResponse {
  content: Block[];
  stop_reason: string;
}

/** Same shape for the real model and the scripted fallback. */
export interface TonyModel {
  readonly name: string;
  readonly usage: { input_tokens: number; output_tokens: number; requests: number };
  send(req: TonyRequest): Promise<TonyResponse>;
}

export const GATEWAY_BASE = process.env.WE_GATEWAY_BASE ?? 'https://ai-gateway.dev.devrev-eng.ai';
export const MODEL_ID = process.env.WE_MODEL ?? 'anthropic.claude-sonnet-5-5';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GatewayTony implements TonyModel {
  readonly name = `gateway:${MODEL_ID}`;
  readonly usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
  private key: string;

  constructor(opts: { maxTokens?: number } = {}) {
    const k = process.env.WE_GATEWAY_KEY;
    if (!k) throw new Error('WE_GATEWAY_KEY is not set (export WE_GATEWAY_KEY=$(security find-generic-password -s arcus-token -a $USER -w))');
    this.key = k;
    this.maxTokens = opts.maxTokens ?? 4096;
  }
  private maxTokens: number;

  async send(req: TonyRequest): Promise<TonyResponse> {
    const body = JSON.stringify({
      model: MODEL_ID,
      max_tokens: this.maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
    });
    let lastErr = 'unknown';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.key}`,
            'x-api-key': this.key,
            'anthropic-version': '2023-06-01',
          },
          body,
          signal: AbortSignal.timeout(180_000),
        });
        if (res.ok) {
          const j: any = await res.json();
          this.usage.requests++;
          this.usage.input_tokens += j.usage?.input_tokens ?? 0;
          this.usage.output_tokens += j.usage?.output_tokens ?? 0;
          return { content: j.content ?? [], stop_reason: j.stop_reason ?? 'end_turn' };
        }
        const text = (await res.text()).slice(0, 300).split(this.key).join('[redacted]');
        lastErr = `HTTP ${res.status}: ${text}`;
        if (res.status !== 429 && res.status < 500) throw new Error(lastErr);
      } catch (e) {
        const msg = (e as Error).message.split(this.key).join('[redacted]');
        if (msg.startsWith('HTTP 4') && !msg.startsWith('HTTP 429')) throw new Error(msg);
        lastErr = msg;
      }
      if (attempt < 3) await sleep(2000 * 2 ** (attempt - 1));
    }
    throw new Error(`gateway request failed after 3 tries: ${lastErr}`);
  }
}

/** System prompt = playbook text + a short replay context. Nothing from expected_end or expected_checks. */
export function buildSystemPrompt(playbook: string, sc: any, dmId: string): string {
  const first = (t: any) => (t.root_text ? `, first message: "${String(t.root_text).replace(/\s+/g, ' ').slice(0, 90)}"` : '');
  const threads = Object.entries<any>(sc.threads ?? {})
    .map(([id, t]) => `- ${id}: channel ${t.channel}${t.root_ts ? `, thread ts ${t.root_ts}` : ''}${t.private ? ', PRIVATE thread' : ''}${first(t)}`)
    .join('\n');
  const people = Object.entries<any>(sc.people ?? {})
    .filter(([, p]) => p.slack)
    .map(([k, p]) => `- ${p.name ?? k}: <@${p.slack}>`)
    .join('\n');
  const faith = !!sc.faithful;
  const threadLines = faith
    ? Object.entries<any>(sc.threads ?? {}).map(([id, t]) => `- ${id} = ${t.channel}:${t.root_ts ?? '(not posted yet)'}${t.private ? ' (PRIVATE thread)' : ''}${first(t)}`).join('\n')
    : threads;
  const threadRule = faith
    ? '- Slack threads are identified as <channel>:<ts> (the request comment\'s external_ref without the slack: prefix). Use that as the `thread` argument in every engine call and in `slack_post` and `slack_read_thread`. Labels (A, B, Q) are for the people reading the report only.'
    : '- Slack threads are labelled. Use the label (for example A) as the `thread` argument in every engine call and in `slack_post` and `slack_read_thread`.';
  return `${playbook.trim()}

## Replay context

This is a rehearsal. Every tool is a stand-in for the real system, and time is simulated. Behave exactly as the playbook says.
${threadRule}
${threadLines}
- People (Slack ids):
${people}
- Tony's own Slack id is ${sc.initial_world?.slack?.tony_user ?? 'U0C4FFYJGE6'}.
- The release tracking issue is ${sc.initial_world?.github?.scripted_ids?.release_issue ?? 'unknown'}${sc.initial_world?.github?.scripted_ids?.parent_issue ? ` (child of ${sc.initial_world.github.scripted_ids.parent_issue})` : ''}; completing it is your last step.
- The release base branch is ${sc.initial_world?.github?.base_branch ?? 'main'} on ${sc.initial_world?.github?.repo ?? 'the repo'}.
- Your job home is ${dmId}. A session starts either when someone mentions you in a Slack thread (it runs in its own conversation, not the job home; your final message is relayed to that thread by the connector) or when the work engine wakes you in the job home (your final message there goes to the home, not to a thread). A wake or notice that arrives while you are working in the home shows up as a new message in your conversation.
- Each session is a fresh conversation. You have no memory of earlier sessions except what the engine briefing and the live sources show.
- The current time is given at the start of each turn. Each of your tool rounds takes about one minute.`;
}
