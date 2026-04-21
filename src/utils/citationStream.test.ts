import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyCitationStreamEvent,
  detectMarkdownStructure,
  extractSseDataEvents,
  mergeCitationItems,
  normalizeCitationReferencesInText,
  normalizeCitationItems,
  parseCitationPayload,
  parseStreamErrorPayload,
  type CitationItem,
  type CitationStreamState,
} from './citationStream';

const citation = (number: number, overrides: Partial<CitationItem> = {}): CitationItem => ({
  citation_number: number,
  document_id: `doc-${number}`,
  document_name: `doc-${number}.pdf`,
  snippet: `snippet ${number}`,
  chunk_index: number - 1,
  ...overrides,
});

describe('citation stream utilities', () => {
  test('normalizeCitationItems filters invalid and sorts by citation_number', () => {
    const normalized = normalizeCitationItems([
      citation(3),
      { ...citation(0), citation_number: 0 },
      { ...citation(2), citation_number: 2 },
      { ...citation(1), citation_number: 1 },
      { citation_number: 'not-a-number' },
    ]);

    assert.deepEqual(normalized.map((item) => item.citation_number), [1, 2, 3]);
  });

  test('normalizeCitationItems normalizes invalid chunk_index values for persistence safety', () => {
    const normalized = normalizeCitationItems([
      {
        ...citation(1),
        chunk_index: Number.NaN,
        chunk_indices: ['5', -3, 'not-a-number'],
      },
      {
        ...citation(2),
        chunk_index: Number.POSITIVE_INFINITY,
        chunk_indices: ['nope'],
      },
      {
        ...citation(3),
        chunk_index: 8.9,
      },
    ]);

    assert.equal(normalized[0].chunk_index, 5);
    assert.deepEqual(normalized[0].chunk_indices, [5]);
    assert.equal(normalized[1].chunk_index, 0);
    assert.equal(normalized[2].chunk_index, 8);
  });

  test('mergeCitationItems deduplicates by citation_number and keeps incoming values', () => {
    const merged = mergeCitationItems(
      [citation(1, { snippet: 'old snippet' }), citation(2)],
      [citation(1, { snippet: 'new snippet' }), citation(3)],
    );

    assert.deepEqual(merged.map((item) => item.citation_number), [1, 2, 3]);
    assert.equal(merged[0].snippet, 'new snippet');
  });

  test('parseCitationPayload parses full/delta/partial events', () => {
    const full = parseCitationPayload(`[CITATIONS] ${JSON.stringify({ items: [citation(1)] })}`);
    const delta = parseCitationPayload(`[CITATIONS_DELTA] ${JSON.stringify({ items: [citation(2)] })}`);
    const partial = parseCitationPayload(
      `[CITATIONS_PARTIAL] ${JSON.stringify({ items: [citation(3)], reason: 'stream_error' })}`,
    );

    assert.equal(full?.type, 'full');
    assert.equal(full?.items.length, 1);

    assert.equal(delta?.type, 'delta');
    assert.equal(delta?.items.length, 1);

    assert.equal(partial?.type, 'partial');
    assert.equal(partial?.reason, 'stream_error');

    assert.equal(parseCitationPayload('plain text'), null);
  });

  test('parseCitationPayload includes partial stream error detail when provided', () => {
    const partial = parseCitationPayload(
      `[CITATIONS_PARTIAL] ${JSON.stringify({ items: [citation(1)], reason: 'stream_error', error: 'Provider stream failed' })}`,
    );

    assert.equal(partial?.type, 'partial');
    assert.equal(partial?.error, 'Provider stream failed');
  });

  test('extractSseDataEvents parses complete SSE events and keeps trailing remainder', () => {
    const payload = [
      'data: hello',
      '',
      'data: [CITATIONS] {"items":[]}',
      '',
      'data: partial',
    ].join('\n');

    const extracted = extractSseDataEvents(payload);

    assert.deepEqual(extracted.events, ['hello', '[CITATIONS] {"items":[]}']);
    assert.equal(extracted.remainder, 'data: partial');
  });

  test('extractSseDataEvents reconstructs multi-line data payloads in one event', () => {
    const payload = [
      'data: [CITATIONS] {"items":[',
      'data: {"citation_number":1}',
      'data: ]}',
      '',
      '',
    ].join('\n');

    const extracted = extractSseDataEvents(payload);

    assert.equal(extracted.events.length, 1);
    assert.equal(
      extracted.events[0],
      '[CITATIONS] {"items":[\n{"citation_number":1}\n]}',
    );
    assert.equal(extracted.remainder, '');
  });

  test('extractSseDataEvents preserves markdown indentation and trailing spaces', () => {
    const payload = [
      'data: ```python',
      'data:     x = 1  ',
      'data:     y = 2',
      'data: ```',
      '',
      '',
    ].join('\n');

    const extracted = extractSseDataEvents(payload);

    assert.equal(extracted.events.length, 1);
    assert.equal(
      extracted.events[0],
      '```python\n    x = 1  \n    y = 2\n```',
    );
  });

  test('extractSseDataEvents preserves leading token space when intentionally present', () => {
    const payload = [
      'data: This',
      '',
      'data:  paper',
      '',
      '',
    ].join('\n');

    const extracted = extractSseDataEvents(payload);

    assert.deepEqual(extracted.events, ['This', ' paper']);
  });

  test('detectMarkdownStructure identifies structured markdown responses', () => {
    const markdown = [
      '### Direct Answer',
      '',
      '- **Finding:** retained students improved.',
      '- `metric_2` remained stable.',
      '',
      '[1](#cite-1)',
    ].join('\n');

    const analysis = detectMarkdownStructure(markdown);

    assert.equal(analysis.hasHeading, true);
    assert.equal(analysis.hasList, true);
    assert.equal(analysis.likelyMarkdown, true);
    assert.ok(analysis.markdownLineRatio > 0.2);
  });

  test('detectMarkdownStructure keeps plain prose as non-markdown', () => {
    const plainText = 'This answer describes the result in plain prose without headings, lists, or markdown links.';

    const analysis = detectMarkdownStructure(plainText);

    assert.equal(analysis.hasHeading, false);
    assert.equal(analysis.hasList, false);
    assert.equal(analysis.hasCodeFence, false);
    assert.equal(analysis.likelyMarkdown, false);
  });

  test('extractSseDataEvents strips only one separator space after data prefix', () => {
    const payload = [
      'data:  - nested item',
      '',
      '',
    ].join('\n');

    const extracted = extractSseDataEvents(payload);

    assert.deepEqual(extracted.events, [' - nested item']);
  });

  test('applyCitationStreamEvent handles mixed DELTA/FULL/PARTIAL sequence', () => {
    let state: CitationStreamState = { items: [] };

    const deltaOne = parseCitationPayload(`[CITATIONS_DELTA] ${JSON.stringify({ items: [citation(1)] })}`);
    const deltaTwo = parseCitationPayload(`[CITATIONS_DELTA] ${JSON.stringify({ items: [citation(2)] })}`);
    const partial = parseCitationPayload(
      `[CITATIONS_PARTIAL] ${JSON.stringify({ items: [citation(3)], reason: 'stream_error' })}`,
    );
    const full = parseCitationPayload(
      `[CITATIONS] ${JSON.stringify({ items: [citation(1), citation(2), citation(3)] })}`,
    );

    if (!deltaOne || !deltaTwo || !partial || !full) {
      throw new Error('Expected all citation payloads to parse');
    }

    state = applyCitationStreamEvent(state, deltaOne);
    state = applyCitationStreamEvent(state, deltaTwo);
    state = applyCitationStreamEvent(state, partial);

    assert.equal(state.status, 'partial');
    assert.equal(state.reason, 'stream_error');
    assert.deepEqual(state.items.map((item) => item.citation_number), [1, 2, 3]);

    state = applyCitationStreamEvent(state, full);
    assert.equal(state.status, 'full');
    assert.equal(state.reason, undefined);
    assert.deepEqual(state.items.map((item) => item.citation_number), [1, 2, 3]);
  });

  test('normalizeCitationReferencesInText expands grouped citations into separate links', () => {
    const output = normalizeCitationReferencesInText(
      'Combined evidence appears in [1, 2] and [3].',
      [citation(1), citation(2), citation(3)],
    );

    assert.equal(
      output,
      'Combined evidence appears in [1](#cite-1), [2](#cite-2) and [3](#cite-3).',
    );
  });

  test('normalizeCitationReferencesInText leaves unknown grouped numbers unlinked', () => {
    const output = normalizeCitationReferencesInText(
      'Cross-check [1, 9] with the notes.',
      [citation(1), citation(2)],
    );

    assert.equal(output, 'Cross-check [1](#cite-1), [9] with the notes.');
  });

  test('normalizeCitationReferencesInText does not double-link existing markdown citation links', () => {
    const output = normalizeCitationReferencesInText(
      'Already linked [1](#cite-1) and plain [2].',
      [citation(1), citation(2)],
    );

    assert.equal(output, 'Already linked [1](#cite-1) and plain [2](#cite-2).');
  });

  test('normalizeCitationReferencesInText avoids linking numbered references embedded in words', () => {
    const output = normalizeCitationReferencesInText(
      'Use labelA[1] and inline[2]token as-is.',
      [citation(1), citation(2)],
    );

    assert.equal(output, 'Use labelA[1] and inline[2]token as-is.');
  });

  test('normalizeCitationReferencesInText only expands grouped citations in citation-like contexts', () => {
    const output = normalizeCitationReferencesInText(
      'Data array[1, 2] should stay while evidence [1, 2] should link.',
      [citation(1), citation(2)],
    );

    assert.equal(
      output,
      'Data array[1, 2] should stay while evidence [1](#cite-1), [2](#cite-2) should link.',
    );
  });

  test('parseStreamErrorPayload extracts json and plain-text stream error payloads', () => {
    const fromJson = parseStreamErrorPayload('[STREAM_ERROR] {"message":"Bad provider credentials"}');
    const fromText = parseStreamErrorPayload('[STREAM_ERROR] upstream failure');
    const noMatch = parseStreamErrorPayload('data fragment');

    assert.equal(fromJson, 'Bad provider credentials');
    assert.equal(fromText, 'upstream failure');
    assert.equal(noMatch, null);
  });
});
