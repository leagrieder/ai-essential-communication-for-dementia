/**
 * probe_prompt.ts — run the real client-side generation path in Node with the
 * network mocked, and print what the app would actually send to the LLM.
 * Usage: npx tsx scripts/probe_prompt.ts
 * No API keys needed; nothing leaves the machine.
 */
import { getDefaultPromptSettings } from '../lib/prompt-settings-shared';

type Captured = { url: string; body: any };
const captured: Captured[] = [];

// Case A (default): user with NO saved settings row (fresh sign-up).
// Case B (SAVED=1): user who pressed Save once; row holds the DB column defaults.
const SAVED_ROW: any = process.env.SAVED === '1'
  ? {
      provider: 'harvard', dualModeProvider: 'harvard', selectedModel: 'gpt-5.5', dualModeSelectedModel: 'gpt-5.5',
      systemPrompt: '', stuckModePrompt: '', suggestedPrompts: [], knowledgeContent: '', coachingResource: '',
      responseMode: 'basic',
    }
  : null;
console.log('CASE:', SAVED_ROW ? 'B (saved row with DB defaults)' : 'A (no saved row)');

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  const body = init?.body ? JSON.parse(init.body) : undefined;
  captured.push({ url, body });

  if (url.includes('/api/prompt-settings')) {
    return new Response(JSON.stringify({ settings: SAVED_ROW, defaults: getDefaultPromptSettings() }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/harvard')) {
    // Classifier: pretend gpt-4o-mini returned a valid, tier-1-complete classification.
    const classification = {
      query_type_id: 'initial_assessment', query_type_label: 'Initial Assessment Guidance',
      in_scope: true, tier1: { age_present: true, symptom_present: true, duration_present: true },
      tier1_complete: true, response_path: 'assess_template_1_or_3', confidence: 'high',
      reasoning: 'mock', missing_elements: [], requires_clarification: false,
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(classification) } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/chat')) {
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'MOCK REPLY' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function main() {
  const { generateClinicalResponseWithHistory } = await import('../src/lib/llm');
  const { DEFAULT_KNOWLEDGE_CHUNKS } = await import('../src/lib/defaultData');

  const prompt = 'My 78-year-old patient has had gradual memory loss for 2 years and is now missing appointments. What should I say to her?';
  const result = await generateClinicalResponseWithHistory(prompt, [], null, undefined, 'basic');

  const chat = captured.find((c) => c.url.includes('/api/chat'));
  if (!chat) { console.log('NO /api/chat CALL CAPTURED'); console.log(captured.map((c) => c.url)); return; }

  const sys: string = chat.body.messages.find((m: any) => m.role === 'system').content;
  const sampleLanguagePhrase = 'Thanks so much for being here today';
  const stuckPointsPhrase = 'Notice & Reframe';
  const primerPhrase = 'Comfort with Ambiguity';

  console.log('=== REQUEST TO /api/chat ===');
  console.log('provider:', chat.body.provider, '| model:', chat.body.model, '| temperature in body:', 'temperature' in chat.body ? chat.body.temperature : '(absent)');
  console.log('template chosen by pipeline:', result.template, '| tier1Complete:', result.tier1Complete);
  console.log('system prompt length (chars):', sys.length);
  console.log('full toolkit chunks available in code (chars):', DEFAULT_KNOWLEDGE_CHUNKS.reduce((n, c) => n + c.content.length, 0));
  console.log('contains Sample Language text  ("' + sampleLanguagePhrase + '"):', sys.includes(sampleLanguagePhrase));
  console.log('contains Stuck Points text     ("' + stuckPointsPhrase + '"):', sys.includes(stuckPointsPhrase));
  console.log('contains full Primer text      ("' + primerPhrase + '"):', sys.includes(primerPhrase));
  console.log('cites "Sample Language (Phase 1" as allowed source:', sys.includes('Sample Language (Phase 1'));

  const start = sys.indexOf('## Toolkit reference');
  const end = sys.indexOf('## Curated External Resources');
  console.log('\n=== TOOLKIT REFERENCE SECTION AS SENT (between the two headers) ===');
  console.log(sys.slice(start, end));
  console.log('=== END SECTION ===');
}

main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
