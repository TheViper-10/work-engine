// R50: the local live probe. Runs the snap-in's real adapters (PlatformStore, PlatformSessionDirectory, PlatformWaker,
// Slack reader, Source reader) and the real Engine, wired by the same assembleRuntime as production, with LOCAL credentials
// against live QA, in its own namespace (env=probe => keys work-engine:probe:tony:...). Run: npx tsx snap-in/scripts/live-probe.ts
// Never prints a token. Never posts to Slack. Cleans up every probe row; hides (never deletes) the home DM.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { DEPLOY_CHECKS, defineConfig } from '../../src/config.ts';
import { SystemClock } from '../../src/clock.ts';
import { assembleRuntime } from '../src/index.ts';
import { httpDeps, QA_ENDPOINT, type Deps, type DevRevApi, type Identity } from '../src/platform.ts';
import { readInputs } from '../src/specs.ts';
import { PlatformSlackReader } from '../src/slack.ts';
import { GithubSourceReader } from '../src/source.ts';
import { PR_GATES } from '../src/index.ts';

const ORG = 'don:core:dvrv-us-1:devo/1lKlCUXYGG';
const TONY = `${ORG}:ai_agent/2`;
const WAKE_WORKFLOW = 'don:integration:dvrv-us-1:devo/1lKlCUXYGG:workflow/58';
const OWNER_DON = 'don:identity:dvrv-us-1:devo/1lKlCUXYGG:devu/1';
const NON_HOME_SESSION = `${ORG}:ai_agent_session/474`;
const NON_HOME_DM = `${ORG}:dm/nHH9Wn2Z`;
const THREAD = 'C0C4K4EGZT6:0000000005.000005';
const WORKFLOW = 'desktop-release';
const TARGET = 'probe-1';
const PREFIX = 'work-engine:probe:';
const REPLY_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------- credentials (values are never printed)
const zshrc = (() => { try { return readFileSync(`${homedir()}/.zshrc`, 'utf8'); } catch { return ''; } })();
function exported(name: string): string {
  const m = new RegExp(`^\\s*export\\s+${name}=(.*)$`, 'm').exec(zshrc);
  return (m?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
}
const fromEnv = (name: string): string => process.env[name] || exported(name);
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const devrevToken = JWT.exec(process.env.TOK || fromEnv('AGENTCORE_RUNTIME_INSTANCE_ORG_TOKEN') || '')?.[0] ?? '';
const slackToken = fromEnv('TONY_SLACK_BOT_TOKEN');
let githubToken = process.env.GITHUB_TOKEN || '';
if (!githubToken) { try { githubToken = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* reported below */ } }
const missing = [['AGENTCORE_RUNTIME_INSTANCE_ORG_TOKEN', devrevToken], ['TONY_SLACK_BOT_TOKEN', slackToken], ['GITHUB_TOKEN', githubToken]].filter(([, v]) => !v).map(([n]) => n);
if (missing.length) { console.error(`missing credentials: ${missing.join(', ')}`); process.exit(2); }

// One event carries the local tokens in every slot the real adapters read: caller, service and owner are all devu/1 here.
const event = {
  context: { secrets: { access_token: devrevToken, service_account_token: devrevToken }, snap_in_id: 'probe' },
  execution_metadata: { devrev_endpoint: QA_ENDPOINT },
  input_data: { resources: { keyrings: { owner_identity: { secret: devrevToken }, tony_slack_token: { secret: slackToken }, github_read: { secret: githubToken } } } },
};

// ---------------------------------------------------------------- recording wrapper over the real HTTP client
interface Call { path: string; as: Identity; status: number; ms: number }
const calls: Call[] = [];
const rowKeys = new Set<string>();
const realApi: DevRevApi = httpDeps.devrev(event);
const api: DevRevApi = {
  async call(path, body, as = 'caller') {
    const t = Date.now();
    try {
      const out = await realApi.call(path, body, as);
      calls.push({ path, as, status: 200, ms: Date.now() - t });
      if (path === 'custom-objects.create' && typeof (body as any).unique_key === 'string') rowKeys.add((body as any).unique_key);
      return out;
    } catch (e) {
      calls.push({ path, as, status: (e as any)?.status ?? -1, ms: Date.now() - t });
      throw e;
    }
  },
};
const deps: Deps = { ...httpDeps, clock: new SystemClock(), devrev: () => api };
const count = (path: string, status?: number) => calls.filter((c) => c.path === path && (status === undefined || c.status === status)).length;

/** Direct platform calls for the probe's own observations and cleanup (not adapter paths). */
async function raw(path: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${QA_ENDPOINT}/internal/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${devrevToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: string) => id.split(':').slice(-1)[0];

// ---------------------------------------------------------------- wiring
const inputs = readInputs({ env: 'probe', bot: 'tony', tony_agent: TONY, wake_user: OWNER_DON, wake_workflow: WAKE_WORKFLOW });
const config = defineConfig({ env: inputs.env, bot: inputs.bot, ownBotUserId: inputs.own_bot_user, checks: DEPLOY_CHECKS });
const rt = assembleRuntime(event, deps, 'service', inputs, config);
const { engine, directory, store } = rt;

interface Step { id: string; name: string; ok: boolean; evidence: string }
const steps: Step[] = [];
const record = (id: string, name: string, ok: boolean, evidence: string) => { steps.push({ id, name, ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}: ${evidence}`); };

let job = '';
let logical = '';
let realDm = '';
let homeSession = '';
const t0 = Date.now();

async function journey(): Promise<void> {
  // (a) job_open from the non-home session
  let t = Date.now();
  const opened = await engine.jobOpen({ workflow: WORKFLOW, target: TARGET, thread: THREAD, role: 'request', intent: 'join' }, { session_id: NON_HOME_SESSION });
  job = String(opened.job ?? '');
  const jobRow: any = job ? await store.get(`${PREFIX}tony:job:${job}`) : null;
  logical = String(jobRow?.dm_id ?? '');
  record('a', 'job_open from session 474', opened.ok === true && !!job && !!logical, `status=${opened.status} job=${job} logical_home=${logical} ${Date.now() - t}ms`);
  if (!job) return;

  // (b) sweep like the timer until the waker creates the home, hides it and triggers once
  t = Date.now();
  let sweeps = 0; let lastSweep = '';
  const deadline = Date.now() + 4 * 60_000;
  let mapRow: any = null;
  while (Date.now() < deadline) {
    const r = await engine.sweep(); sweeps += 1; lastSweep = `${r.status}`;
    mapRow = await store.get(`${PREFIX}tony:dmmap:${logical}`);
    if (mapRow?.state === 'ready' && count('workflows.trigger', 200) >= 1) break;
    await sleep(8000);
  }
  realDm = String(mapRow?.dm ?? '');
  const hideOk = count('chats.update', 200), hideBad = count('chats.update') - hideOk;
  record('b', 'sweep creates+hides the home DM and triggers wake once',
    mapRow?.state === 'ready' && count('chats.create', 200) === 1 && hideOk >= 1 && count('workflows.trigger', 200) === 1,
    `sweeps=${sweeps}(${lastSweep}) dm=${realDm ? short(realDm) : 'none'} dmmap=${mapRow?.state} chats.create=${count('chats.create')} chats.update ok/bad=${hideOk}/${hideBad} workflows.trigger=${count('workflows.trigger', 200)}/${count('workflows.trigger')} ${Date.now() - t}ms`);
  if (!realDm) return;

  // (c) poll the DM timeline (sweeping meanwhile, as the timer would) until Tony replies
  t = Date.now();
  let reply: any = null; let wakeComments = 0; let session = '';
  const until = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < until) {
    const tl = await raw('timeline-entries.list', { object: realDm, limit: 100 });
    const entries: any[] = tl.json?.timeline_entries ?? [];
    wakeComments = entries.filter((e) => typeof e.body === 'string' && e.body.includes(`Work engine wake for job ${job}`)).length;
    // Tony's reply: a comment that is not the wake comment (not written by the wake workflow) and whose author is not the owner's own user id.
    reply = entries.find((e) => typeof e.id === 'string' && e.id.includes(':comment/') && !e.workflow && !String(e.body ?? '').includes('Work engine wake for job') && e.created_by?.id !== OWNER_DON);
    const sl = await raw('ai-agent.sessions.list', { parent: realDm });
    const ours = (sl.json?.agent_sessions ?? []).find((s: any) => s.parent === realDm || s.agent === TONY);
    session = String(ours?.id ?? '');
    if (reply && session) break;
    await engine.sweep().catch(() => undefined);
    await sleep(10_000);
  }
  homeSession = session;
  record('c', 'exactly one wake comment, Tony replies',
    wakeComments === 1 && !!reply && !!homeSession,
    `wake_comments=${wakeComments} reply_entry=${reply ? `${String(reply.id).split(':').slice(-1)[0]} type=${reply.type} by=${String(reply.created_by?.display_name ?? 'n/a').trim()}` : 'none'} session=${homeSession ? short(homeSession) : 'none'} after ${Math.round((Date.now() - t) / 1000)}s`);
  if (!homeSession) return;

  // (d) session lookup resolves to the logical home
  t = Date.now();
  const look = await directory.dmOf(homeSession);
  record('d', 'dmOf(Tony session) == logical home', 'dm' in look && look.dm === logical, `dmOf=${'dm' in look ? look.dm : look.error} expected=${logical} ${Date.now() - t}ms`);
  const nonHome = await directory.dmOf(NON_HOME_SESSION);
  console.log(`     (474 resolves to ${'dm' in nonHome ? short(nonHome.dm) : nonHome.error}, expected ${short(NON_HOME_DM)})`);

  // (e) jobView as the home session
  t = Date.now();
  const view = await engine.jobView({ job }, { session_id: homeSession });
  const v0: any = (view.jobs as any[])?.[0];
  const inHome = view.ok === true && v0?.identity_unconfirmed === false && v0?.home === logical && !/not in the job home/i.test(String(view.say_to_tony));
  record('e', 'jobView as home session shows in-home', inHome, `status=${view.status} home=${v0?.home} identity_unconfirmed=${v0?.identity_unconfirmed} work_run=${v0?.work_run} ${Date.now() - t}ms`);

  // (f) intend
  t = Date.now();
  const routed = await engine.intend({ job, action: 'approve_qa_gate', ref: 'probe' }, { session_id: NON_HOME_SESSION });
  record('f1', 'intend from 474 (non-home) -> route', routed.status === 'route', `status=${routed.status} reason=${String(routed.reason)} ${Date.now() - t}ms`);
  t = Date.now();
  const homeIntend = await engine.intend({ job, action: 'approve_qa_gate', ref: 'probe' }, { session_id: homeSession });
  const holds = (homeIntend.holds as string[] | undefined) ?? [];
  record('f2', 'intend from home -> real check answer (hold no_go_for_build)', homeIntend.status === 'hold' && holds.some((h) => h.includes('no_go_for_build')),
    `status=${homeIntend.status} holds=${JSON.stringify(holds.map((h) => h.slice(0, 90)))} source_calls=github ${Date.now() - t}ms`);

  // (i) read-only Slack and GitHub adapter paths the journey does not reach. No Slack post is made.
  t = Date.now();
  const hist = await fetch(`https://slack.com/api/conversations.history?channel=C0C4K4EGZT6&limit=1`, { headers: { Authorization: `Bearer ${slackToken}` } }).then((r) => r.json()).catch(() => ({})) as any;
  const liveTs = String(hist?.messages?.[0]?.ts ?? '');
  const slackReader = new PlatformSlackReader({ api: httpDeps.slack(event), allow: inputs.slack_channel_allowlist, ownBotUserId: inputs.own_bot_user });
  let slackNote = 'no live ts (history unreadable)'; let slackOk = false;
  if (liveTs) {
    try { const r = await slackReader.findOwnPostAfter(`C0C4K4EGZT6:${liveTs}`, Date.now()); slackOk = r === null || typeof r.link === 'string'; slackNote = `conversations.replies ok, own post after now: ${r === null ? 'none' : 'found'}`; }
    catch (e) { slackNote = `conversations.replies failed (${(e as Error).message.slice(0, 80)})`; }
  }
  const gh = new GithubSourceReader({ api: httpDeps.github(event), repo: inputs.github_repo, branch: inputs.mock_branch, statePath: inputs.state_path, prGates: PR_GATES });
  const served = await gh.servedState();
  const prHead = await gh.currentBuild({ id: job, workflow: WORKFLOW, target: TARGET }, 'pr_review');
  const branchHead = await gh.currentBuild({ id: job, workflow: WORKFLOW, target: TARGET }, 'approve-desktop-qa-latest');
  record('i', 'slack conversations.replies + github contents/pulls/commits (read only)', slackOk && !!served && !!branchHead,
    `${slackNote}; contents=${served ? `ok keys=${Object.keys(served).join(',')}` : 'null'}; pulls=${prHead ?? 'none open (null is a valid answer)'}; commits=${branchHead ?? 'null'} ${Date.now() - t}ms`);
}

async function cleanup(): Promise<void> {
  // (g) adminClose
  let t = Date.now();
  if (job) {
    try { const r = await engine.adminClose(job, 'live probe finished'); record('g', 'adminClose', r.ok === true, `status=${r.status} ${Date.now() - t}ms`); }
    catch (e) { record('g', 'adminClose', false, (e as Error).message.slice(0, 160)); }
  } else record('g', 'adminClose', false, 'no job was opened');

  // (h) hide the DM (never delete), delete every probe row
  t = Date.now();
  let hidden = 'no dm';
  if (realDm) { const h = await raw('chats.update', { id: realDm, type: 'dm', display_state: 'hidden' }); hidden = `chats.update ${h.status}`; }
  // Every created key is known from the recording wrapper; a list scan then catches anything the wrapper missed.
  const ids = new Map<string, string>();
  const lookup = async (uk: string) => { const g = await raw('custom-objects.get', { unique_key: uk }); if (g.status === 200) ids.set(uk, g.json?.custom_object?.id); return g.status; };
  for (const uk of rowKeys) await lookup(uk);
  let scanned = 0; let scanNote = 'list scan ok';
  for (const leaf of ['work_record', 'work_event']) {
    let cursor: string | undefined;
    for (let page = 0; page < 60; page += 1) {
      const l = await raw('custom-objects.list', { leaf_type: leaf, limit: 100, ...(cursor ? { cursor } : {}) });
      if (l.status !== 200) { scanNote = `list scan ${leaf} ${l.status}`; break; }
      for (const o of l.json?.result ?? l.json?.custom_objects ?? []) { scanned += 1; if (typeof o.unique_key === 'string' && o.unique_key.startsWith(PREFIX)) ids.set(o.unique_key, o.id); }
      cursor = l.json?.next_cursor; if (!cursor) break;
    }
  }
  let deleted = 0;
  for (const [, id] of ids) { const d = await raw('custom-objects.delete', { id }); if (d.status === 200) deleted += 1; }
  await sleep(1500);
  let left = 0;
  for (const uk of new Set([...rowKeys, ...ids.keys()])) if ((await raw('custom-objects.get', { unique_key: uk })).status === 200) left += 1;
  record('h', 'cleanup: rows deleted, DM hidden', left === 0 && (!realDm || hidden.endsWith('200')), `${hidden}; rows created=${rowKeys.size} found=${ids.size} deleted=${deleted} left=${left} (${scanNote}, scanned ${scanned}) ${Date.now() - t}ms`);
}

async function main(): Promise<void> {
  try { await journey(); } catch (e) { record('x', 'probe aborted', false, `${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`); }
  finally { try { await cleanup(); } catch (e) { record('h', 'cleanup', false, (e as Error).message.slice(0, 200)); } }

  console.log('\n| step | result | evidence |\n|---|---|---|');
  for (const s of steps) console.log(`| ${s.id} ${s.name} | ${s.ok ? 'PASS' : 'FAIL'} | ${s.evidence.replace(/\|/g, '/')} |`);
  console.log(`\nDM: ${realDm || 'none'}  home session: ${homeSession || 'none'}  total ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`calls: ${JSON.stringify(Object.entries(calls.reduce((m: Record<string, number>, c) => { const k = `${c.path} ${c.status}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})))}`);
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
}
main().catch((e) => { console.error((e as Error).message); process.exit(2); });
