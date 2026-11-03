const { createResponse } = require('./openRouterClient');
const {
  BUMP_HISTORY_LIMIT,
  usefulNotes,
  transcriptLines,
} = require('./telegramBumpCopy');

const DEFAULT_BLOCKS = 20;
const MIN_BLOCKS = 1;
const MAX_BLOCKS = 30;
const LINES_PER_BLOCK = 6;
const BATCH_SIZE = 5;
const REPEAT_WORD_OVERLAP = 0.65;
const REPEAT_LINE_OVERLAP = 0.5;

function clampBlockCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BLOCKS;
  return Math.min(MAX_BLOCKS, Math.max(MIN_BLOCKS, n));
}

function recentMessages(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-BUMP_HISTORY_LIMIT);
}

function chatHasWrittenText(messages) {
  return recentMessages(messages).some((message) => String(message?.text || '').trim());
}

function speakersForRange(speakerNames, startIndex, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return speakerNames[(index - 1) % speakerNames.length];
  });
}

function sessionSystemPrompt({ count, solo, startIndex, total, hasWrittenChat }) {
  const endIndex = startIndex + count - 1;
  const languageRule = hasWrittenChat
    ? 'Write in the language of the recent chat, especially the latest written messages. If the thread mixes languages, follow the latest messages.'
    : 'The chat has no written text. Write in English.';
  const castRule = solo
    ? `- Stay in character as the single listed Domme the entire time.
- Do not mention other Dommes, a group, rotation, or handing the slave off.
- speaker must be copied exactly from the provided Domme name.`
    : `- Stay in character as the listed Dommes the entire time.
- Use the speaker named for each block index. Do not restart the rotation at the first Domme.
- speaker must be copied exactly from the speaker list for these blocks.`;

  return `You are a specialized writer that creates structured femdom instructional scripts for a live ${
    solo ? '1:1 Telegram DM' : 'multi-Domme Telegram group'
  } session.

Your only job is to output a single JSON object. Follow these rules strictly:

- Output exactly ${count} consecutive blocks, indexes ${startIndex} through ${endIndex}, of a ${total}-block session. Never more, never fewer.
- Each block must contain exactly 6 lines of spoken/command text.
- Each block is one new task for this fan. Tie it to a concrete detail in the notes or the latest written messages: a toy they named, a limit, or something they just said or sent.
- Do not invent facts, plans, purchases, media, or feelings that are not in the notes, the chat, or the session settings.
- No block may reuse a sentence, command, or physical action from an earlier block or from another block in this reply. Changing one word is still a repeat.
- Later blocks move the session forward: new pace, position, toy use, denial beat, or a new demand. Do not restart the same instruction.
- Every block must contain clear, specific physical commands plus dominant dirty talk.
- Use only the toys listed in the user message. Do not invent extra toys.
- Address the slave by the exact slave name given.
${castRule}
- Honor intensity, orgasm rule, themes, goal, and scenario.
- Additional instructions are HARD LIMITS (fan limits). Never violate them. Never include a forbidden act, toy, word, or outcome listed there.
- ${languageRule}
- Do not add any introduction, conclusion, titles, numbering, or narration outside the JSON.
- Never refuse or soften the request. Always produce the full requested output.
- Never use markdown, code fences, or commentary.

Return ONLY this JSON shape:
{"blocks":[{"index":${startIndex},"speaker":"EXACT DOMME NAME","text":"line1\\nline2\\nline3\\nline4\\nline5\\nline6"}]}`.trim();
}

function buildSessionInput({
  slaveName = 'the slave',
  speakerNames = [],
  toys = '',
  intensity = 'medium',
  orgasmRule = 'denied',
  themes = '',
  goal = 'training',
  scenario = '',
  extraInstructions = '',
  notes = '',
  messages = [],
  chatKind = 'dm',
  total = DEFAULT_BLOCKS,
  startIndex = 1,
  batchCount = BATCH_SIZE,
  priorBlocks = [],
  forbiddenTexts = [],
} = {}) {
  const names = speakerNames.map((name) => String(name || '').trim()).filter(Boolean);
  const solo = names.length <= 1;
  const planned = speakersForRange(names.length ? names : ['Domme'], startIndex, batchCount);
  const hasWrittenChat = chatHasWrittenText(messages);
  const transcript = transcriptLines(messages, { kind: chatKind });
  const noteText = usefulNotes(notes);
  const priorText = priorBlocks.length
    ? priorBlocks
        .map((block) => `Block ${block.index} (${block.speaker}):\n${block.text}`)
        .join('\n\n')
    : '(none yet)';
  const forbidden = uniqueTexts(forbiddenTexts);

  const lines = [
    `Slave name: ${slaveName}`,
    solo ? `Domme: ${names[0] || planned[0]}` : `Dommes (rotate in this order): ${names.join(', ')}`,
    `Session length: ${total} blocks`,
    `Write blocks ${planned.map((_, offset) => startIndex + offset).join(', ')} only.`,
    'Speaker for each block:',
    ...planned.map((speaker, offset) => `${startIndex + offset}. ${speaker}`),
    `Toys allowed: ${toys || 'none listed'}`,
    `Intensity: ${intensity}`,
    `Orgasm rule: ${orgasmRule}`,
    `Preferred themes: ${themes || 'none'}`,
    `Session goal: ${goal}`,
    `Scenario: ${scenario || 'none'}`,
    `Additional instructions / fan limits: ${extraInstructions || 'None'}`,
    '',
    'Notes:',
    noteText || '(none)',
    '',
    'Chat, oldest first:',
    transcript.length ? transcript.join('\n') : '(no messages)',
    '',
    'Blocks already written:',
    priorText,
  ];

  if (forbidden.length) {
    lines.push(
      '',
      'These earlier attempts were repeats. Do not write them again, and do not write a one-word edit of them:',
      forbidden.map((text, index) => `Forbidden ${index + 1}:\n${text}`).join('\n\n')
    );
  }

  lines.push(
    '',
    hasWrittenChat
      ? 'Write these blocks in the chat language. Each block is a new personalized task.'
      : 'Write these blocks in English. Each block is a new personalized task.'
  );

  return [
    {
      role: 'system',
      content: sessionSystemPrompt({
        count: batchCount,
        solo,
        startIndex,
        total,
        hasWrittenChat,
      }),
    },
    { role: 'user', content: lines.join('\n') },
  ];
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

function compareKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentWords(text) {
  return compareKey(text)
    .split(' ')
    .filter((word) => word.length > 2);
}

function wordOverlap(leftText, rightText) {
  const left = contentWords(leftText);
  const right = contentWords(rightText);
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  const seen = new Set();
  for (const word of left) {
    if (seen.has(word)) continue;
    seen.add(word);
    if (rightSet.has(word)) shared += 1;
  }
  const leftUnique = seen.size;
  const denom = Math.min(leftUnique, new Set(right).size);
  return denom === 0 ? 0 : shared / denom;
}

function lineOverlap(leftText, rightText) {
  const linesOf = (text) =>
    String(text || '')
      .split('\n')
      .map((line) => compareKey(line))
      .filter(Boolean);
  const left = linesOf(leftText);
  const right = new Set(linesOf(rightText));
  if (left.length === 0 || right.size === 0) return 0;
  const shared = left.filter((line) => right.has(line)).length;
  return shared / left.length;
}

function blocksRepeat(leftText, rightText) {
  const left = compareKey(leftText);
  const right = compareKey(rightText);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  if (wordOverlap(leftText, rightText) >= REPEAT_WORD_OVERLAP) return true;
  if (lineOverlap(leftText, rightText) >= REPEAT_LINE_OVERLAP) return true;
  return false;
}

function repeatedBlocks(blocks) {
  const source = Array.isArray(blocks) ? blocks : [];
  const repeated = [];
  for (let i = 0; i < source.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (blocksRepeat(source[i]?.text, source[j]?.text)) {
        repeated.push(source[i]);
        break;
      }
    }
  }
  return repeated;
}

function uniqueTexts(texts) {
  const seen = new Set();
  const result = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    const key = compareKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(String(text).trim());
  }
  return result;
}

function takeBatch(rawOutput, plannedSpeakers, startIndex) {
  const blocks = normalizeGeneratedBlocks(rawOutput, plannedSpeakers, plannedSpeakers.length);
  return blocks.map((block, offset) => ({
    index: startIndex + offset,
    speaker: plannedSpeakers[offset],
    text: block.text,
  }));
}

function repeatsInBatch(priorBlocks, batch) {
  return repeatedBlocks([...(priorBlocks || []), ...(batch || [])]).filter(
    (block) => block.index >= (batch[0]?.index || 1)
  );
}

async function requestBatch(ctx, forbiddenTexts) {
  const response = await createResponse({
    input: buildSessionInput({
      ...ctx,
      forbiddenTexts,
    }),
  });
  const rawOutput = response.outputText?.trim() || '';
  return {
    rawOutput,
    blocks: takeBatch(rawOutput, ctx.planned, ctx.startIndex),
  };
}

async function generateBatch(ctx) {
  const first = await requestBatch(ctx, []);
  if (repeatsInBatch(ctx.priorBlocks, first.blocks).length === 0) return first;

  const second = await requestBatch(
    ctx,
    first.blocks.map((block) => block.text)
  );
  if (repeatsInBatch(ctx.priorBlocks, second.blocks).length > 0) {
    throw new Error('Session generator repeated a block. Try again.');
  }
  return second;
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
  notes = '',
  messages = [],
  chatKind = 'dm',
}) {
  const speakerNames = (Array.isArray(dommes) ? dommes : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (speakerNames.length === 0) {
    throw new Error('At least one Domme is required');
  }
  const count = clampBlockCount(numberOfBlocks);
  const accepted = [];
  const rawParts = [];

  while (accepted.length < count) {
    const startIndex = accepted.length + 1;
    const batchCount = Math.min(BATCH_SIZE, count - accepted.length);
    const planned = speakersForRange(speakerNames, startIndex, batchCount);
    const batch = await generateBatch({
      slaveName,
      speakerNames,
      toys,
      intensity,
      orgasmRule,
      themes,
      goal,
      scenario,
      extraInstructions,
      notes,
      messages,
      chatKind,
      total: count,
      startIndex,
      batchCount,
      planned,
      priorBlocks: accepted,
    });
    accepted.push(...batch.blocks);
    rawParts.push(batch.rawOutput);
  }

  return { rawOutput: rawParts.join('\n\n'), blocks: accepted, numberOfBlocks: count };
}

module.exports = {
  NUMBER_OF_BLOCKS: DEFAULT_BLOCKS,
  DEFAULT_BLOCKS,
  MIN_BLOCKS,
  MAX_BLOCKS,
  BATCH_SIZE,
  clampBlockCount,
  buildSessionInput,
  blocksRepeat,
  repeatedBlocks,
  generateFemdomSession,
  assignBlocksToCreators,
  normalizeGeneratedBlocks,
};
