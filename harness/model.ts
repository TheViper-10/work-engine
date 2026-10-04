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

/**
 * Trivial scripted Tony for when the gateway is unreachable (D14): reads the briefing for the first
 * thread named in the trigger, then stops. It exercises the driver, not the playbook. The real-model
 * run is then recorded as parked.
 */
export class ScriptedTony implements TonyModel {
  readonly name = 'scripted';
  readonly usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
  async send(req: TonyRequest): Promise<TonyResponse> {
    this.usage.requests++;
    const assistantTurns = req.messages.filter((m) => m.role === 'assistant').length;
    const first = typeof req.messages[0]?.content === 'string' ? (req.messages[0]!.content as string) : '';
    const thread = /thread (\w+)/.exec(first)?.[1];
    if (assistantTurns === 0 && thread && req.tools.some((t) => t.name === 'job_view')) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_scripted_1', name: 'job_view', input: { thread } }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Checked the briefing; nothing to do right now.' }] };
  }
}

/** System prompt = playbook text + a short replay context. Nothing from expected_end or expected_checks. */
export function buildSystemPrompt(playbook: string, sc: any, dmId: string): string {
  const threads = Object.entries<any>(sc.threads ?? {})
    .map(([id, t]) => `- ${id}: channel ${t.channel}${t.root_ts ? `, thread ts ${t.root_ts}` : ''}${t.private ? ', PRIVATE thread' : ''}`)
    .join('\n');
  const people = Object.entries<any>(sc.people ?? {})
    .filter(([, p]) => p.slack)
    .map(([k, p]) => `- ${p.name ?? k}: <@${p.slack}>`)
    .join('\n');
  return `${playbook.trim()}

## Replay context

This is a rehearsal. Every tool is a stand-in for the real system, and time is simulated. Behave exactly as the playbook says.
- Slack threads are labelled. Use the label (for example A) as the \`thread\` argument in every engine call and in \`slack_post\` and \`slack_read_thread\`.
${threads}
- People (Slack ids):
${people}
- Tony's own Slack id is ${sc.initial_world?.slack?.tony_user ?? 'U0C4FFYJGE6'}.
- The release base branch is ${sc.initial_world?.github?.base_branch ?? 'main'} on ${sc.initial_world?.github?.repo ?? 'the repo'}.
- Your job direct message is ${dmId}. A session starts either when someone mentions you in a thread (your final message is relayed to that thread by the connector) or when the work engine wakes you in that direct message (your final message there goes to the direct message, not to a thread).
- Each session is a fresh conversation. You have no memory of earlier sessions except what the engine briefing and the live sources show.
- The current time is given at the start of each turn. Each of your tool rounds takes about one minute.`;
}
