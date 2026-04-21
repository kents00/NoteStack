export type CitationItem = {
  citation_number: number;
  document_id: string;
  document_name: string;
  snippet: string;
  chunk_index: number;
  chunk_indices?: number[];
  source_label?: string;
};

export type CitationStreamEventType = 'full' | 'delta' | 'partial';

export type CitationStreamEvent = {
  type: CitationStreamEventType;
  items: CitationItem[];
  reason?: string;
  error?: string;
};

export type CitationStreamState = {
  items: CitationItem[];
  status?: 'full' | 'partial';
  reason?: string;
  error?: string;
};

export type SseDataExtractionResult = {
  events: string[];
  remainder: string;
};

export type MarkdownStructureDetection = {
  hasHeading: boolean;
  hasList: boolean;
  hasCodeFence: boolean;
  hasTable: boolean;
  hasBlockquote: boolean;
  markdownLineRatio: number;
  likelyMarkdown: boolean;
};

const STREAM_ERROR_PREFIX = '[STREAM_ERROR] ';

const CITATION_PREFIXES: Array<{ prefix: string; type: CitationStreamEventType }> = [
  { prefix: '[CITATIONS] ', type: 'full' },
  { prefix: '[CITATIONS_DELTA] ', type: 'delta' },
  { prefix: '[CITATIONS_PARTIAL] ', type: 'partial' },
];

export const extractSseDataEvents = (buffer: string): SseDataExtractionResult => {
  const normalized = String(buffer || '').replace(/\r\n?/g, '\n');
  const events: string[] = [];
  let remainder = normalized;

  while (true) {
    const delimiterIndex = remainder.indexOf('\n\n');
    if (delimiterIndex < 0) {
      break;
    }

    const rawEvent = remainder.slice(0, delimiterIndex);
    remainder = remainder.slice(delimiterIndex + 2);

    if (!rawEvent.trim()) {
      continue;
    }

    const eventDataLines = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        const payload = line.slice(5);
        // SSE allows a single optional separator space after "data:".
        return payload.startsWith(' ') ? payload.slice(1) : payload;
      });

    if (eventDataLines.length > 0) {
      events.push(eventDataLines.join('\n'));
    }
  }

  return { events, remainder };
};

export const detectMarkdownStructure = (text: string): MarkdownStructureDetection => {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return {
      hasHeading: false,
      hasList: false,
      hasCodeFence: false,
      hasTable: false,
      hasBlockquote: false,
      markdownLineRatio: 0,
      likelyMarkdown: false,
    };
  }

  const lines = normalized.split('\n');
  let markdownLineCount = 0;
  let hasHeading = false;
  let hasList = false;
  let hasCodeFence = false;
  let hasTable = false;
  let hasBlockquote = false;
  let insideCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('```')) {
      hasCodeFence = true;
      markdownLineCount += 1;
      insideCodeFence = !insideCodeFence;
      continue;
    }

    if (insideCodeFence) {
      markdownLineCount += 1;
      continue;
    }

    const heading = /^#{1,6}\s/.test(trimmed);
    const list = /^([-*+]\s|\d+[.)]\s)/.test(trimmed);
    const table = /^\|.+\|$/.test(trimmed);
    const blockquote = /^>\s?/.test(trimmed);
    const inlineMarkdown = /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(trimmed);

    hasHeading = hasHeading || heading;
    hasList = hasList || list;
    hasTable = hasTable || table;
    hasBlockquote = hasBlockquote || blockquote;

    if (heading || list || table || blockquote || inlineMarkdown) {
      markdownLineCount += 1;
    }
  }

  const markdownLineRatio = markdownLineCount / Math.max(lines.length, 1);
  const likelyMarkdown = hasHeading || hasList || hasCodeFence || hasTable || hasBlockquote || markdownLineRatio >= 0.25;

  return {
    hasHeading,
    hasList,
    hasCodeFence,
    hasTable,
    hasBlockquote,
    markdownLineRatio,
    likelyMarkdown,
  };
};

export const normalizeCitationItems = (items: unknown): CitationItem[] => {
  if (!Array.isArray(items)) return [];

  return items
    .map((item: any) => {
      const normalizedChunkIndices = Array.isArray(item?.chunk_indices)
        ? item.chunk_indices
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isFinite(value) && value >= 0)
            .map((value: number) => Math.trunc(value))
        : undefined;

      const normalizedChunkIndexCandidate = Number(item?.chunk_index);
      const normalizedChunkIndex = Number.isFinite(normalizedChunkIndexCandidate) && normalizedChunkIndexCandidate >= 0
        ? Math.trunc(normalizedChunkIndexCandidate)
        : (normalizedChunkIndices?.[0] ?? 0);

      return {
        citation_number: Number(item?.citation_number),
        document_id: String(item?.document_id || ''),
        document_name: String(item?.document_name || ''),
        snippet: String(item?.snippet || ''),
        chunk_index: normalizedChunkIndex,
        chunk_indices: normalizedChunkIndices,
        source_label: typeof item?.source_label === 'string' ? item.source_label : undefined,
      };
    })
    .filter((item: CitationItem) => Number.isFinite(item.citation_number) && item.citation_number > 0)
    .sort((a, b) => a.citation_number - b.citation_number);
};

export const mergeCitationItems = (currentItems: CitationItem[], incomingItems: CitationItem[]): CitationItem[] => {
  if (incomingItems.length === 0) return currentItems;

  const byNumber = new Map<number, CitationItem>();
  for (const item of currentItems) {
    byNumber.set(item.citation_number, item);
  }
  for (const item of incomingItems) {
    byNumber.set(item.citation_number, item);
  }

  return Array.from(byNumber.values()).sort((a, b) => a.citation_number - b.citation_number);
};

export const parseCitationPayload = (data: string): CitationStreamEvent | null => {
  const matchedPrefix = CITATION_PREFIXES.find((entry) => data.startsWith(entry.prefix));
  if (!matchedPrefix) return null;

  try {
    const parsed = JSON.parse(data.slice(matchedPrefix.prefix.length));
    return {
      type: matchedPrefix.type,
      items: normalizeCitationItems(parsed?.items),
      reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
      error: typeof parsed?.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    return {
      type: matchedPrefix.type,
      items: [],
    };
  }
};

export const applyCitationStreamEvent = (
  state: CitationStreamState,
  event: CitationStreamEvent,
): CitationStreamState => {
  const normalizedIncomingItems = normalizeCitationItems(event.items);

  if (event.type === 'full') {
    return {
      items: mergeCitationItems([], normalizedIncomingItems),
      status: 'full',
      reason: undefined,
      error: undefined,
    };
  }

  if (event.type === 'partial') {
    return {
      items: mergeCitationItems(state.items, normalizedIncomingItems),
      status: 'partial',
      reason: event.reason,
      error: event.error,
    };
  }

  return {
    ...state,
    items: mergeCitationItems(state.items, normalizedIncomingItems),
  };
};

export const parseStreamErrorPayload = (data: string): string | null => {
  if (!data.startsWith(STREAM_ERROR_PREFIX)) return null;

  const payload = data.slice(STREAM_ERROR_PREFIX.length).trim();
  if (!payload) {
    return 'The response stream failed before any output was produced.';
  }

  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Non-JSON payload; return raw fallback below.
  }

  return payload;
};

export const normalizeCitationReferencesInText = (
  text: string,
  citationItems?: CitationItem[],
): string => {
  if (!text || !citationItems || citationItems.length === 0) return text;

  let normalizedText = text;
  const citationNumbers = new Set(citationItems.map((item) => item.citation_number));

  // Expand grouped citations like [1, 2] or [1;2] into individual linked refs.
  // Restrict matching to citation-like contexts so list-like bracket text is not rewritten.
  normalizedText = normalizedText.replace(
    /(^|[\s(])\[((?:\s*\d+\s*[,;]\s*)+\d+\s*)\](?!\(#cite-\d+\))/gm,
    (_match, prefix: string, groupText: string) => {
      const numbers = groupText
        .split(/[;,]/)
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);

      if (numbers.length === 0) return _match;

      const expanded = numbers
        .map((number) => (
          citationNumbers.has(number)
            ? `[${number}](#cite-${number})`
            : `[${number}]`
        ))
        .join(', ');

      return `${prefix}${expanded}`;
    },
  );

  // Normalize singular [n] citations that are not yet linked.
  for (const number of citationNumbers) {
    const pattern = new RegExp(`(^|[\\s(])\\[${number}\\](?!\\(#cite-${number}\\))(?=([\\s.,;:!?)]|$))`, 'gm');
    normalizedText = normalizedText.replace(pattern, `$1[${number}](#cite-${number})`);
  }

  return normalizedText;
};
