/**
 * eval_routing.ts — run the 45-case evaluation set through the REAL classification
 * pipeline (safety pre-filter → gpt-4o-mini structured classification → template
 * selection) and report routing accuracy.
 *
 * Usage:
 *   npx tsx scripts/eval_routing.ts                 # all 45 cases, 1 run each
 *   npx tsx scripts/eval_routing.ts --runs 3        # repeat each case 3× to measure consistency
 *   npx tsx scripts/eval_routing.ts --cases eval_001,eval_037
 *   npx tsx scripts/eval_routing.ts --limit 5
 *   npx tsx scripts/eval_routing.ts --dry           # no API calls; checks the harness only
 *
 * Needs HARVARD_OPENAI_KEY in .env.local (same file the app uses). Nothing else.
 * The app's classifier calls `/api/harvard`; this script intercepts that call and
 * forwards it to the Harvard gateway exactly as src/app/api/harvard/route.ts would,
 * so the pipeline code under test is unmodified.
 *
 * Output: a summary on stdout and a JSON file under eval-results/ with every raw
 * classification, so results can be re-analysed and cited.
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RUNS = Number(flag('runs') ?? 1);
const LIMIT = flag('limit') ? Number(flag('limit')) : undefined;
const CASES = flag('cases')?.split(',').map((s) => s.trim());
const DRY = argv.includes('--dry');

// ---------- .env.local (no dotenv dependency) ----------
function loadEnvLocal(): Record<string, string> {
  const p = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnvLocal(), ...process.env };
const HARVARD_KEY = env.HARVARD_OPENAI_KEY;
const HARVARD_BASE = (env.HARVARD_OPENAI_BASE_URL ?? 'https://go.apis.huit.harvard.edu/ais-openai-direct/v2/').replace(/\/$/, '');
const NO_TEMP_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']);

if (!DRY && !HARVARD_KEY) {
  console.error('HARVARD_OPENAI_KEY not found in .env.local or environment. Add it, or use --dry.');
  process.exit(1);
}

// ---------- intercept the app's /api/harvard call and forward it like the server route ----------
let apiCalls = 0;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/api/harvard')) return realFetch(input, init);
  apiCalls++;
  const body = JSON.parse(init.body);
  if (DRY) {
    // Deterministic stand-in so the harness can be exercised without a key.
    const fake = {
      query_type_id: 'initial_assessment', query_type_label: 'Initial Assessment Guidance', in_scope: true,
      tier1: { age_present: false, symptom_present: true, duration_present: false }, tier1_complete: false,
      response_path: 'assess_template_1_or_3', confidence: 'low', reasoning: 'dry run', missing_elements: ['age', 'duration'],
      requires_clarification: true,
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fake) } }] }), { status: 200 });
  }
  const model = typeof body.model === 'string' ? body.model : 'gpt-4o-mini';
  const payload: Record<string, unknown> = { messages: body.messages, model, stream: false };
  if (!NO_TEMP_MODELS.has(model)) payload.temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  if (body.response_format) payload.response_format = body.response_format;
  const upstream = await realFetch(`${HARVARD_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': HARVARD_KEY! },
    body: JSON.stringify(payload),
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
};

// ---------- types ----------
interface EvalCase {
  id: string; category: string; prompt: string; expected_path: string;
  expected_tier1_complete?: boolean; expected_missing?: string[]; safety_override?: boolean; notes?: string;
}
interface RunRecord {
  id: string; run: number; category: string; prompt: string;
  expected_path: string; expected_tier1_complete?: boolean;
  got_path: string; got_tier1_complete: boolean; got_query_type?: string; got_confidence?: string;
  safety_override: boolean; fallback: boolean; fallback_reason?: string;
  path_ok: boolean; tier1_ok: boolean | null; query_type_ok: boolean | null;
  latency_ms: number; error?: string;
}

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

async function main() {
  const { runClassificationPipeline } = await import('../src/lib/classifier/pipeline');
  const evalSet = JSON.parse(fs.readFileSync(path.resolve('src/lib/evaluation/evalSet.json'), 'utf-8')) as {
    version: string; lastUpdated: string; testCases: EvalCase[];
  };

  let cases = evalSet.testCases;
  if (CASES) cases = cases.filter((c) => CASES.includes(c.id));
  if (LIMIT) cases = cases.slice(0, LIMIT);

  const gitHead = (() => { try { return fs.readFileSync('.git/HEAD', 'utf-8').trim(); } catch { return 'unknown'; } })();
  console.log(`eval set v${evalSet.version} (${evalSet.lastUpdated}) — ${cases.length} cases × ${RUNS} run(s)${DRY ? ' [DRY]' : ''}`);

  const records: RunRecord[] = [];
  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      const rec: Partial<RunRecord> = {
        id: c.id, run, category: c.category, prompt: c.prompt,
        expected_path: c.expected_path, expected_tier1_complete: c.expected_tier1_complete,
      };
      try {
        const r = await runClassificationPipeline(c.prompt, [], 'openai');
        rec.got_path = r.template;
        rec.got_tier1_complete = r.tier1Complete;
        rec.got_query_type = r.classification?.query_type_id;
        rec.got_confidence = r.classification?.confidence;
        rec.safety_override = r.safetyOverride;
        rec.fallback = r.fallbackTriggered;
        rec.fallback_reason = r.fallbackReason;
      } catch (e: any) {
        rec.error = String(e?.message ?? e);
        rec.got_path = 'ERROR'; rec.got_tier1_complete = false; rec.safety_override = false; rec.fallback = true;
      }
      rec.latency_ms = Date.now() - t0;
      rec.path_ok = rec.got_path === c.expected_path;
      // Tier-1 only meaningful on the 1-or-3 path; elsewhere the eval set's flag is descriptive.
      rec.tier1_ok = c.expected_path === 'assess_template_1_or_3' && typeof c.expected_tier1_complete === 'boolean'
        ? rec.got_tier1_complete === c.expected_tier1_complete : null;
      rec.query_type_ok = rec.got_query_type ? rec.got_query_type === c.category : null;
      records.push(rec as RunRecord);

      const mark = rec.path_ok ? 'ok ' : 'XX ';
      const t1 = rec.tier1_ok === null ? '   ' : rec.tier1_ok ? 't1✓' : 't1✗';
      console.log(`${mark}${t1} ${c.id} run${run}  expected=${c.expected_path.padEnd(23)} got=${String(rec.got_path).padEnd(23)} qtype=${rec.got_query_type ?? '-'}${rec.fallback ? '  [fallback: ' + rec.fallback_reason + ']' : ''}${rec.error ? '  ERROR ' + rec.error : ''}`);
    }
  }

  // ---------- summary ----------
  const n = records.length;
  const pathOk = records.filter((r) => r.path_ok).length;
  const tier1Eligible = records.filter((r) => r.tier1_ok !== null);
  const tier1Ok = tier1Eligible.filter((r) => r.tier1_ok).length;
  const qtEligible = records.filter((r) => r.query_type_ok !== null);
  const qtOk = qtEligible.filter((r) => r.query_type_ok).length;
  const fallbacks = records.filter((r) => r.fallback).length;
  const lowConf = records.filter((r) => r.got_confidence === 'low').length;
  const errors = records.filter((r) => r.error).length;

  console.log('\n=== SUMMARY ===');
  console.log(`routing (template) accuracy : ${pct(pathOk, n)}  (${pathOk}/${n})`);
  console.log(`tier-1 completeness accuracy: ${pct(tier1Ok, tier1Eligible.length)}  (${tier1Ok}/${tier1Eligible.length}, 1-or-3 cases only)`);
  console.log(`query-type accuracy         : ${pct(qtOk, qtEligible.length)}  (${qtOk}/${qtEligible.length}, vs evalSet category)`);
  console.log(`fallbacks / low confidence  : ${fallbacks} / ${lowConf}    errors: ${errors}    API calls: ${apiCalls}`);
  console.log(`median latency              : ${[...records].sort((a, b) => a.latency_ms - b.latency_ms)[Math.floor(n / 2)]?.latency_ms ?? 0} ms`);

  console.log('\nper expected path:');
  const byPath = new Map<string, RunRecord[]>();
  for (const r of records) byPath.set(r.expected_path, [...(byPath.get(r.expected_path) ?? []), r]);
  for (const [p, rs] of [...byPath.entries()].sort()) {
    console.log(`  ${p.padEnd(24)} ${pct(rs.filter((r) => r.path_ok).length, rs.length)}  (${rs.filter((r) => r.path_ok).length}/${rs.length})`);
  }

  // Confusion: expected → got
  console.log('\nconfusions (expected → got: count):');
  const conf = new Map<string, number>();
  for (const r of records) if (!r.path_ok) conf.set(`${r.expected_path} → ${r.got_path}`, (conf.get(`${r.expected_path} → ${r.got_path}`) ?? 0) + 1);
  if (conf.size === 0) console.log('  none');
  for (const [k, v] of [...conf.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  if (RUNS > 1) {
    console.log(`\nconsistency across ${RUNS} runs (same case, same template every time):`);
    const byId = new Map<string, RunRecord[]>();
    for (const r of records) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    let stable = 0;
    for (const [, rs] of byId) if (new Set(rs.map((r) => r.got_path)).size === 1) stable++;
    console.log(`  stable cases: ${stable}/${byId.size}  (${pct(stable, byId.size)})`);
    for (const [id, rs] of byId) {
      const paths = rs.map((r) => r.got_path);
      if (new Set(paths).size > 1) console.log(`  unstable ${id}: ${paths.join(' | ')}`);
    }
  }

  // ---------- persist ----------
  const outDir = path.resolve('eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `routing_${stamp}${DRY ? '_dry' : ''}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    meta: {
      when: new Date().toISOString(), git_head: gitHead, eval_set_version: evalSet.version, eval_set_date: evalSet.lastUpdated,
      cases: cases.length, runs: RUNS, dry: DRY, classifier_model: 'gpt-4o-mini (hard-coded in openaiClassifier.ts)',
      summary: {
        routing_accuracy: n ? pathOk / n : null, tier1_accuracy: tier1Eligible.length ? tier1Ok / tier1Eligible.length : null,
        query_type_accuracy: qtEligible.length ? qtOk / qtEligible.length : null, fallbacks, low_confidence: lowConf, errors,
      },
    },
    records,
  }, null, 2), 'utf-8');
  console.log(`\nraw results written to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => { console.error('EVAL FAILED:', e); process.exit(1); });
