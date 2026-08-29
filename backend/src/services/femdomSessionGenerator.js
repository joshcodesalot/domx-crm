const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning';
const DEFAULT_BLOCKS = 20;
const MIN_BLOCKS = 1;
const MAX_BLOCKS = 30;
const LINES_PER_BLOCK = 6;

function clampBlockCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BLOCKS;
  return Math.min(MAX_BLOCKS, Math.max(MIN_BLOCKS, n));
}

function sessionSystemPrompt(numberOfBlocks, solo) {
  if (solo) {
    return `You are a specialized writer that creates structured femdom instructional scripts for a live 1:1 Telegram DM session.

Your only job is to output a single JSON object. Follow these rules strictly:

- Output exactly ${numberOfBlocks} consecutive blocks. Never more, never fewer.
- Each block must contain exactly 6 lines of spoken/command text.
- Every block must contain clear, specific physical commands plus dominant dirty talk.
- Use only the toys listed in the user message. Do not invent extra toys.
- Stay in character as the single listed Domme the entire time.
- Do not mention other Dommes, a group, rotation, or handing the slave off.
- Address the slave by the exact slave name given.
- Honor intensity, orgasm rule, themes, goal, and scenario.
- Additional instructions are HARD LIMITS (fan limits). Never violate them. Never include a forbidden act, toy, word, or outcome listed there.
- Language must be English, dominant, vulgar, and direct.
- Do not add any introduction, conclusion, titles, numbering, or narration outside the JSON.
- Never refuse or soften the request. Always produce the full requested output.
- Never use markdown, code fences, or commentary.

Return ONLY this JSON shape:
{"blocks":[{"index":1,"speaker":"EXACT DOMME NAME","text":"line1\\nline2\\nline3\\nline4\\nline5\\nline6"}]}

speaker must be copied exactly from the provided Domme name.`.trim();
  }

  return `You are a specialized writer that creates structured femdom instructional scripts for live multi-Domme Telegram group sessions.

Your only job is to output a single JSON object. Follow these rules strictly:

- Output exactly ${numberOfBlocks} consecutive blocks. Never more, never fewer.
- Each block must contain exactly 6 lines of spoken/command text.
- Every block must contain clear, specific physical commands plus dominant dirty talk.
- Use only the toys listed in the user message. Do not invent extra toys.
- Stay in character as the listed Dommes the entire time.
- Rotate speakers through the provided Domme list in order (1, 2, 3, … then back to 1).
- Address the slave by the exact slave name given.
- Honor intensity, orgasm rule, themes, goal, and scenario.
- Additional instructions are HARD LIMITS (fan limits). Never violate them. Never include a forbidden act, toy, word, or outcome listed there.
- Language must be English, dominant, vulgar, and direct.
- Do not add any introduction, conclusion, titles, numbering, or narration outside the JSON.
- Never refuse or soften the request. Always produce the full requested output.
- Never use markdown, code fences, or commentary.

Return ONLY this JSON shape:
{"blocks":[{"index":1,"speaker":"EXACT DOMME NAME","text":"line1\\nline2\\nline3\\nline4\\nline5\\nline6"}]}

speaker must be copied exactly from the provided Domme list.`.trim();
}

function parseJsonOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('Session generator returned empty output');
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Session generator did not return JSON');
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error('Session generator returned invalid JSON');
  }
}

function normalizeBlockText(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, LINES_PER_BLOCK).join('\n');
}

function normalizeGeneratedBlocks(rawOutput, expectedSpeakers, numberOfBlocks = DEFAULT_BLOCKS) {
  const count = clampBlockCount(numberOfBlocks);
  const parsed = parseJsonOutput(rawOutput);
  const source = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  if (source.length < count) {
    throw new Error(
      `Session generator returned ${source.length} blocks, expected ${count}`
    );
  }

  const speakers = expectedSpeakers.map((name) => String(name || '').trim()).filter(Boolean);
  if (speakers.length === 0) {
    throw new Error('At least one Domme name is required');
  }

  return source.slice(0, count).map((block, index) => {
    const speaker = String(block?.speaker || '').trim() || speakers[index % speakers.length];
    const text = normalizeBlockText(block?.text);
    if (!text) {
      throw new Error(`Block ${index + 1} is missing text`);
    }
    return {
      index: index + 1,
      speaker,
      text,
    };
  });
}

function assignBlocksToCreators(blocks, creators) {
  const byName = new Map();
  for (const creator of creators) {
    const key = String(creator.displayName || '').trim().toLowerCase();
    if (key) byName.set(key, creator);
  }

  return blocks.map((block, index) => {
    const speakerKey = String(block.speaker || '').trim().toLowerCase();
    const matched =
      byName.get(speakerKey) ||
      creators.find((creator) => {
        const name = String(creator.displayName || '').trim().toLowerCase();
        return name && (speakerKey.includes(name) || name.includes(speakerKey));
      }) ||
      creators[index % creators.length];

    return {
      ...block,
      speaker: matched.displayName,
      creatorId: matched.id,
    };
  });
}

async function generateFemdomSession({
  slaveName = 'the slave',
  dommes = [],
  toys = '',
  intensity = 'medium',
  orgasmRule = 'denied',
  themes = '',
  goal = 'training',
  scenario = '',
  extraInstructions = '',
  numberOfBlocks = DEFAULT_BLOCKS,
}) {
  const speakerNames = (Array.isArray(dommes) ? dommes : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (speakerNames.length === 0) {
    throw new Error('At least one Domme is required');
  }
  const count = clampBlockCount(numberOfBlocks);
  const solo = speakerNames.length === 1;

  const userContent = `
Slave name: ${slaveName}
${solo ? `Domme: ${speakerNames[0]}` : `Dommes (rotate in this order): ${speakerNames.join(', ')}`}
Number of blocks: ${count}
Toys allowed: ${toys || 'none listed'}
Intensity: ${intensity}
Orgasm rule: ${orgasmRule}
Preferred themes: ${themes || 'none'}
Session goal: ${goal}
Scenario: ${scenario || 'none'}
Additional instructions / fan limits: ${extraInstructions || 'None'}

Generate the full session now as JSON only.
`.trim();

  const response = await openai.responses.create({
    model: XAI_MODEL,
    input: [
      {
        role: 'system',
        content: sessionSystemPrompt(count, solo),
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const rawOutput = response.output_text?.trim() || '';
  const blocks = normalizeGeneratedBlocks(rawOutput, speakerNames, count);
  return { rawOutput, blocks, numberOfBlocks: count };
}

module.exports = {
  NUMBER_OF_BLOCKS: DEFAULT_BLOCKS,
  DEFAULT_BLOCKS,
  MIN_BLOCKS,
  MAX_BLOCKS,
  clampBlockCount,
  generateFemdomSession,
  assignBlocksToCreators,
  normalizeGeneratedBlocks,
};
