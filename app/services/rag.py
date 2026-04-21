import json
import os
import re
import uuid
from urllib.parse import urlparse
import httpx
from langchain_openai import ChatOpenAI
import chromadb
from chromadb.utils import embedding_functions
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic
from langchain_community.llms import Ollama
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from app.schemas.chat import ChatRequest
from app.db.database import SessionLocal
from app.models.document import Document
from app.core.storage import get_file_path
from app.services.extractor import extract_text

CHROMA_PERSIST_DIR = "chroma_data"
TARGET_CITATION_SNIPPET_CHARS = 320
MIN_CITATION_SNIPPET_CHARS = 280
MAX_TARGET_CITATION_SNIPPET_CHARS = 360
MAX_CITATION_SNIPPET_CHARS = 500
SNIPPET_STRIP_CHARS = " ,;:-"
DEFAULT_SIMILARITY_K = 5
MULTI_DOC_MIN_TOTAL = 6
MULTI_DOC_MAX_TOTAL = 12
CITATION_EVENT_FULL = "[CITATIONS]"
CITATION_EVENT_DELTA = "[CITATIONS_DELTA]"
CITATION_EVENT_PARTIAL = "[CITATIONS_PARTIAL]"
PROVIDER_ALIASES = {
    "chatgpt": "openai",
    "claude": "anthropic",
    "lm_studio": "local",
    "ollama": "local",
}
DEFAULT_LOCAL_MODEL_CONTEXT_LENGTH = 4096
DEFAULT_LOCAL_PROMPT_TOKEN_MARGIN = 256
DEFAULT_LOCAL_MIN_PROMPT_TOKENS = 512
LOCAL_PROMPT_TRUNCATION_MARKER = "\n\n...[truncated to fit local model context]...\n\n"
DEFAULT_BASE_INSTRUCTIONS = (
    "You are NoteStack, an evidence-grounded assistant for document Q&A and comparison.\n"
    "Answer only from the provided document context and relevant chat history.\n"
    "Do not invent facts, and if context is insufficient, reply exactly with: "
    "I cannot answer this based on the provided documents.\n"
    "For multi-document questions, clearly separate agreements and differences.\n"
    "Keep answers concise, precise, and non-redundant.\n\n"
    "Formatting rules:\n"
    "- Format responses using well-structured markdown.\n"
    "- Use ### headings to organize sections (e.g., ### Direct Answer, ### Key Evidence).\n"
    "- Leave blank lines between paragraphs, before/after headings, and around lists.\n"
    "- Bold key terms and important findings with **double asterisks**.\n"
    "- Use bullet lists for evidence points."
)


def _safe_int(value, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _normalize_provider_name(provider: str) -> str:
    normalized = (provider or "").strip().lower()
    return PROVIDER_ALIASES.get(normalized, normalized)


def _read_positive_int_env(var_name: str, fallback: int) -> int:
    raw_value = (os.getenv(var_name) or "").strip()
    if not raw_value:
        return fallback

    value = _safe_int(raw_value, fallback)
    return value if value > 0 else fallback


def _get_local_prompt_budget_tokens() -> int:
    explicit_max_tokens = _read_positive_int_env("LOCAL_PROMPT_MAX_TOKENS", 0)
    if explicit_max_tokens > 0:
        return max(DEFAULT_LOCAL_MIN_PROMPT_TOKENS, explicit_max_tokens)

    context_length = _read_positive_int_env("LOCAL_MODEL_CONTEXT_LENGTH", 0)
    if context_length <= 0:
        context_length = _read_positive_int_env("LM_STUDIO_CONTEXT_LENGTH", 0)
    if context_length <= 0:
        context_length = _read_positive_int_env("LOCAL_CONTEXT_LENGTH", DEFAULT_LOCAL_MODEL_CONTEXT_LENGTH)

    margin_tokens = _read_positive_int_env("LOCAL_PROMPT_TOKEN_MARGIN", DEFAULT_LOCAL_PROMPT_TOKEN_MARGIN)
    computed_budget = context_length - margin_tokens
    if computed_budget < DEFAULT_LOCAL_MIN_PROMPT_TOKENS:
        computed_budget = max(DEFAULT_LOCAL_MIN_PROMPT_TOKENS, int(context_length * 0.75))

    return computed_budget


def _approx_token_count(text: str) -> int:
    normalized = (text or "").strip()
    if not normalized:
        return 0

    char_tokens = max(1, len(normalized) // 4)
    word_tokens = max(1, int(len(re.findall(r"\S+", normalized)) * 1.1))
    return max(char_tokens, word_tokens)


def _truncate_text_to_token_budget(text: str, max_tokens: int) -> str:
    normalized = (text or "").strip()
    if not normalized or max_tokens <= 0:
        return ""

    if _approx_token_count(normalized) <= max_tokens:
        return normalized

    for ratio in (0.85, 0.7, 0.55, 0.4, 0.3, 0.2):
        keep_chars = max(64, int(max_tokens * 4 * ratio))
        head_chars = max(1, int(keep_chars * 0.7))
        tail_chars = max(1, keep_chars - head_chars)

        candidate = (
            normalized[:head_chars].rstrip()
            + LOCAL_PROMPT_TRUNCATION_MARKER
            + normalized[-tail_chars:].lstrip()
        )
        if _approx_token_count(candidate) <= max_tokens:
            return candidate

    # Final fallback for short-token/high-word-ratio content.
    words = normalized.split()
    if len(words) <= max_tokens:
        return " ".join(words)

    head_words = max(1, int(max_tokens * 0.7))
    tail_words = max(1, max_tokens - head_words)
    return " ".join(words[:head_words]) + LOCAL_PROMPT_TRUNCATION_MARKER + " ".join(words[-tail_words:])


def _format_local_history_lines(history_messages) -> list[str]:
    history_lines: list[str] = []
    for msg in history_messages:
        role = "User" if msg.role == "user" else "Assistant"
        text = (msg.text or "").strip()
        if text:
            history_lines.append(f"{role}: {text}")
    return history_lines


def _trim_local_history_lines(history_lines: list[str], max_tokens: int) -> str:
    if not history_lines or max_tokens <= 0:
        return "(none)"

    selected_lines: list[str] = []
    used_tokens = 0
    for line in reversed(history_lines):
        line_tokens = _approx_token_count(line) + 1

        if line_tokens > max_tokens and not selected_lines:
            truncated_line = _truncate_text_to_token_budget(line, max_tokens)
            if truncated_line:
                selected_lines.append(truncated_line)
            break

        if used_tokens + line_tokens > max_tokens:
            break

        selected_lines.append(line)
        used_tokens += line_tokens

    if not selected_lines:
        return "(none)"

    selected_lines.reverse()
    return "\n".join(selected_lines)


def _compose_local_rag_prompt(
    base_instructions: str,
    context_text: str,
    history_text: str,
    user_query: str,
    provider_label: str,
) -> str:
    return (
        f"{base_instructions}\n\n"
        "Use only the DOCUMENT CONTEXT to answer the user.\n"
        "Cite evidence using markdown links in this exact format: [n](#cite-n).\n"
        "Use only citation numbers present in DOCUMENT CONTEXT.\n"
        "Do not invent citation numbers.\n"
        "If the answer is not in the document context, reply exactly with: "
        "I cannot answer this based on the provided documents.\n\n"
        f"DOCUMENT CONTEXT:\n{context_text}\n\n"
        f"CHAT HISTORY:\n{history_text}\n\n"
        f"USER QUESTION:\n{user_query}\n\n"
        "Answer with concise, accurate details and cite supporting evidence inline.\n"
        f"Provider context: {provider_label}.\n"
        "Format your response with ### headings, bullet lists, and **bold** key terms. "
        "Leave blank lines between paragraphs and around headings."
    )


def _build_local_rag_prompt(
    base_instructions: str,
    context: str,
    history_messages,
    user_query: str,
    provider: str = "local",
) -> str:
    history_lines = _format_local_history_lines(history_messages)
    history_text = "\n".join(history_lines) if history_lines else "(none)"
    context_text = context if context else "[No relevant document chunks were retrieved.]"
    provider_label = (provider or "local").strip().lower()
    token_budget = _get_local_prompt_budget_tokens()

    prompt = _compose_local_rag_prompt(
        base_instructions=base_instructions,
        context_text=context_text,
        history_text=history_text,
        user_query=user_query,
        provider_label=provider_label,
    )
    if _approx_token_count(prompt) <= token_budget:
        return prompt

    # Keep the most recent conversational turns when trimming history.
    history_budget = max(128, int(token_budget * 0.25))
    history_text = _trim_local_history_lines(history_lines, history_budget)

    prompt = _compose_local_rag_prompt(
        base_instructions=base_instructions,
        context_text=context_text,
        history_text=history_text,
        user_query=user_query,
        provider_label=provider_label,
    )
    if _approx_token_count(prompt) <= token_budget:
        return prompt

    placeholder_context = "[Document context truncated to fit local model context limit.]"
    prompt_without_context = _compose_local_rag_prompt(
        base_instructions=base_instructions,
        context_text=placeholder_context,
        history_text=history_text,
        user_query=user_query,
        provider_label=provider_label,
    )
    available_context_tokens = max(96, token_budget - _approx_token_count(prompt_without_context))
    context_text = _truncate_text_to_token_budget(context_text, available_context_tokens)

    prompt = _compose_local_rag_prompt(
        base_instructions=base_instructions,
        context_text=context_text or placeholder_context,
        history_text=history_text,
        user_query=user_query,
        provider_label=provider_label,
    )
    if _approx_token_count(prompt) <= token_budget:
        return prompt

    instruction_budget = max(128, int(token_budget * 0.35))
    trimmed_instructions = _truncate_text_to_token_budget(base_instructions, instruction_budget)
    prompt = _compose_local_rag_prompt(
        base_instructions=trimmed_instructions or base_instructions,
        context_text=context_text or placeholder_context,
        history_text=history_text,
        user_query=user_query,
        provider_label=provider_label,
    )

    if _approx_token_count(prompt) <= token_budget:
        return prompt

    return _truncate_text_to_token_budget(prompt, token_budget)


def _compact_text(text: str) -> str:
    return " ".join((text or "").split())


def _normalize_context_text(text: str) -> str:
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    if not normalized:
        return ""

    # Keep markdown structure while preventing extremely long blank-line runs.
    normalized = re.sub(r"\n{4,}", "\n\n\n", normalized)
    normalized = normalized.strip("\n")
    return normalized if normalized.strip() else ""


def _repair_glued_connector_words(text: str) -> str:
    if not text:
        return ""

    stem_suffixes = (
        "ly",
        "ed",
        "ing",
        "ion",
        "ment",
        "ness",
        "ity",
        "ive",
        "ous",
        "al",
        "ary",
        "ence",
        "ance",
        "ate",
        "ize",
        "ise",
        "ful",
        "less",
    )
    connector_pattern = "and|or|the|with|from|for|that|than"
    stem_suffix_pattern = "|".join(stem_suffixes)

    repaired = re.sub(
        rf"\b([a-z]{{4,}}(?:{stem_suffix_pattern}))({connector_pattern})([a-z]{{3,}})\b",
        r"\1 \2 \3",
        text,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        rf"\b([a-z]{{4,}}(?:{stem_suffix_pattern}))({connector_pattern})\b",
        r"\1 \2",
        repaired,
        flags=re.IGNORECASE,
    )
    return repaired


def _truncate_citation_snippet(snippet: str) -> str:
    normalized_snippet = (snippet or "").replace("\r\n", "\n").replace("\r", "\n")
    normalized_snippet = re.sub(r"[ \t\f\v]+", " ", normalized_snippet)
    normalized_snippet = re.sub(r"\n{3,}", "\n\n", normalized_snippet)
    text = _repair_glued_connector_words(normalized_snippet).strip()
    if not text:
        return ""

    preferred_target = min(TARGET_CITATION_SNIPPET_CHARS, MAX_CITATION_SNIPPET_CHARS)
    if len(text) <= preferred_target:
        return text

    hard_limit = min(len(text), MAX_CITATION_SNIPPET_CHARS)
    working = text[:hard_limit].rstrip()
    if not working:
        return ""

    soft_limit = min(len(working), MAX_TARGET_CITATION_SNIPPET_CHARS)
    min_boundary = min(MIN_CITATION_SNIPPET_CHARS, soft_limit)

    sentence_match = None
    for match in re.finditer(r"[.!?](?:['\")\]]+)?(?:\s|$)", working[:soft_limit]):
        if match.end() >= min_boundary:
            sentence_match = match

    if sentence_match is not None:
        trimmed = working[:sentence_match.end()].strip(SNIPPET_STRIP_CHARS)
    else:
        whitespace_boundaries = [index for index, char in enumerate(working[:soft_limit]) if char.isspace()]
        trimmed = ""
        for boundary in reversed(whitespace_boundaries):
            if boundary >= min_boundary:
                trimmed = working[:boundary].strip(SNIPPET_STRIP_CHARS)
                break
        if not trimmed:
            fallback_boundary = min(preferred_target, len(working))
            trimmed = working[:fallback_boundary].strip(SNIPPET_STRIP_CHARS)

    if not trimmed:
        trimmed = working.strip(SNIPPET_STRIP_CHARS)

    return f"{trimmed}..." if len(trimmed) < len(text) else trimmed


def _tokenize_overlap_terms(text: str) -> list[str]:
    if not text:
        return []
    tokens = [token for token in re.findall(r"[a-z0-9]+", text.lower()) if len(token) >= 3]
    # Preserve order while deduplicating.
    deduped = []
    seen = set()
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        deduped.append(token)
    return deduped


def _snippet_relevance_score(candidate: str, query_terms: list[str]) -> float:
    compact_candidate = _compact_text(candidate)
    if not compact_candidate:
        return float("-inf")

    lowered = compact_candidate.lower()
    overlap = sum(1 for term in query_terms if term in lowered)
    score = float(overlap * 4)

    # Prefer sentence-sized snippets.
    length = len(compact_candidate)
    if 55 <= length <= 220:
        score += 2.0
    elif length < 30:
        score -= 1.5

    # De-prioritize bibliographic/noisy fragments where possible.
    noise_markers = (
        "issn",
        "doi",
        "conference proceedings",
        "creative commons",
        "copyright",
    )
    if any(marker in lowered for marker in noise_markers):
        score -= 2.0

    letters = [ch for ch in compact_candidate if ch.isalpha()]
    if letters:
        uppercase_ratio = sum(1 for ch in letters if ch.isupper()) / len(letters)
        if uppercase_ratio > 0.65:
            score -= 1.0

    return score


def _score_snippet_for_terms(snippet: str, query_terms: list[str]) -> float:
    if query_terms:
        score = _snippet_relevance_score(snippet, query_terms)
    else:
        score = 0.0 if not snippet else 1.0

    if _looks_like_low_signal_snippet(snippet):
        # Strongly down-rank author/header noise so we prefer readable evidence.
        score -= 8.0

    return score


def _generate_snippet_candidates(page_content: str) -> list[str]:
    compact_page = _compact_text(page_content)
    if not compact_page:
        return []

    protected_content = page_content or ""
    for abbreviation in (
        "e.g.",
        "i.e.",
        "et al.",
        "dr.",
        "mr.",
        "mrs.",
        "ms.",
        "prof.",
        "u.s.",
    ):
        protected_content = re.sub(
            re.escape(abbreviation),
            lambda match: match.group(0).replace(".", "<DOT>"),
            protected_content,
            flags=re.IGNORECASE,
        )

    candidates = [
        segment.strip().replace("<DOT>", ".")
        for segment in re.split(r"(?<=[.!?;])\s+|\n+", protected_content)
        if segment and segment.strip()
    ]

    # Fallback for OCR/PDF text that often arrives as one long run-on line:
    # evaluate overlapping token windows so we can skip noisy author headers.
    words = compact_page.split()
    if len(words) > 20:
        for window_size in (36, 52):
            step = max(12, window_size // 3)
            for start in range(0, len(words), step):
                window = words[start:start + window_size]
                if len(window) < 18:
                    continue
                candidates.append(" ".join(window))

    if not candidates:
        candidates = [compact_page]

    deduped = []
    seen = set()
    for candidate in candidates:
        compact_candidate = _compact_text(candidate)
        if not compact_candidate:
            continue
        if compact_candidate in seen:
            continue
        seen.add(compact_candidate)
        deduped.append(compact_candidate)

    return deduped


def _sanitize_low_signal_snippet(snippet: str) -> str:
    text = _compact_text(snippet)
    if not text:
        return ""

    text = re.sub(r"\bmail\s*id\b\s*:\s*", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b\d(?:\s*,\s*\d){3,}\b", " ", text)
    text = _repair_glued_connector_words(text)
    text = re.sub(r"\s{2,}", " ", text).strip(SNIPPET_STRIP_CHARS)
    return text


def _extract_reference_snippet(page_content: str, query_text: str) -> str:
    compact_page = _compact_text(page_content)
    if not compact_page:
        return ""

    query_terms = _tokenize_overlap_terms(query_text)
    candidates = _generate_snippet_candidates(page_content)
    if not candidates:
        return _truncate_citation_snippet(compact_page)

    scored = [(_score_snippet_for_terms(candidate, query_terms), candidate) for candidate in candidates]
    best_score, best_candidate = max(scored, key=lambda item: item[0])

    if best_score <= 0:
        quality_scored = [(_score_snippet_for_terms(candidate, []), candidate) for candidate in candidates]
        _, best_candidate = max(quality_scored, key=lambda item: item[0])

    if _looks_like_low_signal_snippet(best_candidate):
        clean_candidates = [candidate for candidate in candidates if not _looks_like_low_signal_snippet(candidate)]
        if clean_candidates:
            clean_scored = [(_score_snippet_for_terms(candidate, query_terms), candidate) for candidate in clean_candidates]
            _, best_candidate = max(clean_scored, key=lambda item: item[0])
        else:
            sanitized = _sanitize_low_signal_snippet(best_candidate)
            if sanitized and not _looks_like_low_signal_snippet(sanitized):
                best_candidate = sanitized

    return _truncate_citation_snippet(best_candidate)


def _extract_document_id_from_chunk_id(chunk_id: str) -> str:
    chunk_id_value = (chunk_id or "").strip()
    if not chunk_id_value:
        return ""

    if ":" in chunk_id_value:
        possible_id = chunk_id_value.split(":", 1)[0].strip()
        if possible_id:
            return possible_id

    return ""


def _get_citation_group_key(metadata: dict, fallback_index: int) -> str:
    chunk_id = str(metadata.get("chunk_id") or "").strip()
    if chunk_id:
        return f"chunk:{chunk_id}"

    document_id = str(metadata.get("document_id") or "").strip()
    chunk_index = _safe_int(metadata.get("chunk_index"), -1)
    if document_id and chunk_index >= 0:
        return f"id:{document_id}:chunk:{chunk_index}"
    if document_id:
        return f"id:{document_id}:fallback:{fallback_index}"

    chunk_derived_document_id = _extract_document_id_from_chunk_id(chunk_id)
    if chunk_derived_document_id and chunk_index >= 0:
        return f"id:{chunk_derived_document_id}:chunk:{chunk_index}"
    if chunk_derived_document_id:
        return f"id:{chunk_derived_document_id}:fallback:{fallback_index}"

    source_path = str(
        metadata.get("source")
        or metadata.get("file_path")
        or metadata.get("path")
        or ""
    ).strip().lower()
    if source_path and chunk_index >= 0:
        return f"source:{source_path}:chunk:{chunk_index}"
    if source_path:
        return f"source:{source_path}:fallback:{fallback_index}"

    document_name = str(metadata.get("name") or "").strip().lower()
    if document_name and chunk_index >= 0:
        return f"name:{document_name}:chunk:{chunk_index}"
    if document_name:
        return f"name:{document_name}:fallback:{fallback_index}"

    if chunk_index >= 0:
        return f"fallback:chunk:{chunk_index}:{fallback_index}"

    return f"fallback:{fallback_index}"


def _get_citation_item_group_key(citation: dict) -> str:
    explicit_group_key = str(citation.get("_group_key") or "").strip()
    if explicit_group_key:
        return explicit_group_key

    chunk_id = str(citation.get("chunk_id") or "").strip()
    if chunk_id:
        return f"chunk:{chunk_id}"

    document_id = str(citation.get("document_id") or "").strip()
    chunk_index = _safe_int(citation.get("chunk_index"), -1)
    if document_id and chunk_index >= 0:
        return f"id:{document_id}:chunk:{chunk_index}"
    if document_id:
        return f"id:{document_id}"

    document_name = str(citation.get("document_name") or "").strip().lower()
    if document_name and chunk_index >= 0:
        return f"name:{document_name}:chunk:{chunk_index}"
    if document_name:
        return f"name:{document_name}"

    return f"citation:{citation.get('citation_number', 0)}"


def _build_source_label(document_name: str, chunk_indices: list[int]) -> str:
    if not chunk_indices:
        return document_name

    if len(chunk_indices) == 1:
        return f"{document_name} (Chunk {chunk_indices[0] + 1})"

    preview = ", ".join(str(index + 1) for index in chunk_indices[:4])
    if len(chunk_indices) > 4:
        preview = f"{preview}, +{len(chunk_indices) - 4} more"
    return f"{document_name} (Chunks {preview})"


def _group_source_entries(source_entries: list[dict]) -> dict[str, list[dict]]:
    grouped_entries: dict[str, list[dict]] = {}
    for entry_index, entry in enumerate(source_entries, start=1):
        metadata = entry.get("metadata") or {}
        group_key = _get_citation_group_key(metadata, entry_index)
        grouped_entries.setdefault(group_key, []).append(entry)
    return grouped_entries


def _extract_citation_focus_text(answer_text: str, citation_number: int) -> str:
    if not answer_text:
        return ""

    citation_pattern = rf"\[{citation_number}\](?:\(#cite-{citation_number}\))?"
    windows: list[str] = []
    for match in re.finditer(citation_pattern, answer_text):
        start = max(0, match.start() - 220)
        end = min(len(answer_text), match.end() + 220)

        left_bound = max(
            answer_text.rfind(".", 0, start),
            answer_text.rfind("!", 0, start),
            answer_text.rfind("?", 0, start),
            answer_text.rfind("\n", 0, start),
        )
        if left_bound >= 0 and start - left_bound <= 180:
            start = left_bound + 1

        right_candidates = [
            idx
            for idx in (
                answer_text.find(".", end),
                answer_text.find("!", end),
                answer_text.find("?", end),
                answer_text.find("\n", end),
            )
            if idx >= 0
        ]
        if right_candidates:
            right_bound = min(right_candidates)
            if right_bound - end <= 180:
                end = right_bound + 1

        window = _compact_text(answer_text[start:end])
        if window:
            windows.append(window)

    return " ".join(windows[:3])


def _looks_like_low_signal_snippet(snippet: str) -> bool:
    lowered = (snippet or "").lower()
    if not lowered:
        return True

    if re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", lowered):
        return True

    if "mail id" in lowered:
        return True

    if re.search(r"\b\d(?:\s*,\s*\d){3,}\b", lowered):
        return True

    noise_markers = (
        "issn",
        "doi",
        "department of",
        "university",
        "conference proceedings",
        "copyright",
    )
    if any(marker in lowered for marker in noise_markers) and snippet.count(",") >= 4:
        return True

    if snippet.count(",") >= 10 and len(snippet) < 280:
        return True

    return False


def _select_best_entry_snippet(
    entries: list[dict],
    focus_text: str,
    fallback_text: str,
) -> tuple[str, int]:
    if not entries:
        return "", 0

    search_text = (focus_text or "").strip() or (fallback_text or "").strip()
    search_terms = _tokenize_overlap_terms(search_text)

    best_snippet_any = ""
    best_chunk_index_any = 0
    best_score_any = float("-inf")

    best_snippet_clean = ""
    best_chunk_index_clean = 0
    best_score_clean = float("-inf")

    for entry in entries:
        metadata = entry.get("metadata") or {}
        chunk_index = _safe_int(metadata.get("chunk_index"), 0)
        page_content = str(entry.get("page_content") or "")
        if not page_content.strip():
            continue

        candidate_snippet = _extract_reference_snippet(page_content, search_text)
        score = _score_snippet_for_terms(candidate_snippet, search_terms)
        is_low_signal = _looks_like_low_signal_snippet(candidate_snippet)

        if score > best_score_any:
            best_score_any = score
            best_snippet_any = candidate_snippet
            best_chunk_index_any = chunk_index

        if not is_low_signal and score > best_score_clean:
            best_score_clean = score
            best_snippet_clean = candidate_snippet
            best_chunk_index_clean = chunk_index

    if best_snippet_clean:
        return best_snippet_clean, best_chunk_index_clean

    return best_snippet_any, best_chunk_index_any


def _build_source_entries_from_retrieved_docs(retrieved_docs) -> list[dict]:
    return [
        {
            "page_content": doc.page_content,
            "metadata": doc.metadata or {},
        }
        for doc in retrieved_docs
    ]


def _interleave_retrieved_docs(retrieved_by_doc: list[list]) -> list:
    if not retrieved_by_doc:
        return []

    interleaved = []
    max_len = max((len(results) for results in retrieved_by_doc), default=0)
    for index in range(max_len):
        for results in retrieved_by_doc:
            if index < len(results):
                interleaved.append(results[index])
    return interleaved


def _dedupe_retrieved_docs(retrieved_docs: list) -> list:
    deduped = []
    seen = set()
    for doc in retrieved_docs:
        metadata = getattr(doc, "metadata", None) or {}
        document_id = str(metadata.get("document_id") or "")
        chunk_id = str(metadata.get("chunk_id") or "")
        content_key = chunk_id or str(getattr(doc, "page_content", ""))
        key = f"{document_id}:{content_key}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(doc)
    return deduped


def _retrieve_docs_for_query(vectorstore, user_query: str, document_ids: list[str] | None):
    if not document_ids:
        return vectorstore.similarity_search(query=user_query, k=DEFAULT_SIMILARITY_K)

    normalized_ids = [str(doc_id).strip() for doc_id in document_ids if str(doc_id).strip()]
    if not normalized_ids:
        return vectorstore.similarity_search(query=user_query, k=DEFAULT_SIMILARITY_K)

    deduped_ids: list[str] = []
    seen_ids = set()
    for doc_id in normalized_ids:
        if doc_id in seen_ids:
            continue
        seen_ids.add(doc_id)
        deduped_ids.append(doc_id)

    if len(deduped_ids) == 1:
        return vectorstore.similarity_search(
            query=user_query,
            k=DEFAULT_SIMILARITY_K,
            filter={"document_id": {"$in": deduped_ids}},
        )

    doc_count = len(deduped_ids)
    target_total = max(MULTI_DOC_MIN_TOTAL, min(MULTI_DOC_MAX_TOTAL, doc_count * 2))
    per_doc_k = max(2, (target_total + doc_count - 1) // doc_count)

    retrieved_by_doc = []
    for doc_id in deduped_ids:
        retrieved_by_doc.append(
            vectorstore.similarity_search(
                query=user_query,
                k=per_doc_k,
                filter={"document_id": doc_id},
            )
        )

    interleaved = _interleave_retrieved_docs(retrieved_by_doc)
    return _dedupe_retrieved_docs(interleaved)[:target_total]


class _DocResult:
    """Lightweight shim so native ChromaDB results look like LangChain Documents."""
    __slots__ = ("page_content", "metadata")

    def __init__(self, page_content: str, metadata: dict):
        self.page_content = page_content
        self.metadata = metadata


def _chroma_query_to_docs(results: dict) -> list["_DocResult"]:
    """Convert a chromadb Collection.query() result dict into _DocResult objects."""
    docs = []
    documents = results.get("documents") or []
    metadatas = results.get("metadatas") or []
    for doc_list, meta_list in zip(documents, metadatas):
        for text, meta in zip(doc_list, meta_list):
            docs.append(_DocResult(page_content=text or "", metadata=meta or {}))
    return docs


def _retrieve_docs_for_query_native(
    collection,
    embed_fn,
    user_query: str,
    document_ids: list[str] | None,
) -> list["_DocResult"]:
    """Retrieve docs using the native ChromaDB Collection API (no LangChain wrapper)."""
    query_embeddings = embed_fn([user_query])

    normalized_ids = [str(doc_id).strip() for doc_id in (document_ids or []) if str(doc_id).strip()]
    deduped_ids: list[str] = []
    seen_ids: set[str] = set()
    for doc_id in normalized_ids:
        if doc_id not in seen_ids:
            seen_ids.add(doc_id)
            deduped_ids.append(doc_id)

    if not deduped_ids:
        results = collection.query(
            query_embeddings=query_embeddings,
            n_results=DEFAULT_SIMILARITY_K,
            include=["documents", "metadatas"],
        )
        return _chroma_query_to_docs(results)

    if len(deduped_ids) == 1:
        results = collection.query(
            query_embeddings=query_embeddings,
            n_results=DEFAULT_SIMILARITY_K,
            where={"document_id": {"$in": deduped_ids}},
            include=["documents", "metadatas"],
        )
        return _chroma_query_to_docs(results)

    doc_count = len(deduped_ids)
    target_total = max(MULTI_DOC_MIN_TOTAL, min(MULTI_DOC_MAX_TOTAL, doc_count * 2))
    per_doc_k = max(2, (target_total + doc_count - 1) // doc_count)

    retrieved_by_doc: list[list["_DocResult"]] = []
    for doc_id in deduped_ids:
        results = collection.query(
            query_embeddings=query_embeddings,
            n_results=per_doc_k,
            where={"document_id": doc_id},
            include=["documents", "metadatas"],
        )
        retrieved_by_doc.append(_chroma_query_to_docs(results))

    interleaved = _interleave_retrieved_docs(retrieved_by_doc)
    return _dedupe_retrieved_docs(interleaved)[:target_total]



def _load_direct_file_context_entries(
    document_ids: list[str],
    max_docs: int = 3,
    max_chars_per_doc: int = 3500,
) -> list[dict]:
    parsed_ids = []
    for doc_id in document_ids:
        try:
            parsed_ids.append(uuid.UUID(str(doc_id)))
        except Exception:
            continue

    if not parsed_ids:
        return []

    db = SessionLocal()
    try:
        docs = (
            db.query(Document)
            .filter(Document.id.in_(parsed_ids))
            .limit(max_docs)
            .all()
        )

        entries = []
        for doc in docs:
            if not doc.s3_key:
                continue
            try:
                file_path = get_file_path(doc.s3_key)
                raw_text = extract_text(file_path, doc.mime_type)
            except Exception:
                continue

            text = _normalize_context_text(raw_text)
            if not text:
                continue
            entries.append(
                {
                    "page_content": text[:max_chars_per_doc],
                    "metadata": {
                        "document_id": str(doc.id),
                        "name": doc.name,
                        "chunk_index": 0,
                    },
                }
            )

        return entries
    finally:
        db.close()


def _build_citation_items(source_entries: list[dict], query_text: str) -> list[dict]:
    citations = []
    citation_by_group_key: dict[str, dict] = {}
    query_terms = _tokenize_overlap_terms(query_text)

    for entry_index, entry in enumerate(source_entries, start=1):
        metadata = entry.get("metadata") or {}
        group_key = _get_citation_group_key(metadata, entry_index)
        page_content = str(entry.get("page_content") or "")
        candidate_snippet = _extract_reference_snippet(page_content, query_text)
        chunk_index = _safe_int(metadata.get("chunk_index"), entry_index - 1)

        existing = citation_by_group_key.get(group_key)
        if existing is None:
            citation_number = len(citations) + 1
            document_name = str(metadata.get("name") or f"Source Document {citation_number}")
            citation = {
                "citation_number": citation_number,
                "_group_key": group_key,
                "document_id": str(metadata.get("document_id") or ""),
                "document_name": document_name,
                "snippet": candidate_snippet,
                "chunk_index": chunk_index,
                "chunk_id": str(metadata.get("chunk_id") or ""),
                "chunk_indices": [chunk_index] if chunk_index >= 0 else [],
            }
            citation_by_group_key[group_key] = citation
            citations.append(citation)
            continue

        if chunk_index not in existing["chunk_indices"]:
            existing["chunk_indices"].append(chunk_index)

        current_snippet = existing.get("snippet", "")
        current_is_low_signal = _looks_like_low_signal_snippet(current_snippet)
        candidate_is_low_signal = _looks_like_low_signal_snippet(candidate_snippet)

        if current_is_low_signal and not candidate_is_low_signal:
            existing["snippet"] = candidate_snippet
            existing["chunk_index"] = chunk_index
            continue

        current_score = _score_snippet_for_terms(current_snippet, query_terms)
        candidate_score = _score_snippet_for_terms(candidate_snippet, query_terms)
        if candidate_score > current_score:
            existing["snippet"] = candidate_snippet
            existing["chunk_index"] = chunk_index

    for citation in citations:
        chunk_indices = sorted({index for index in citation.get("chunk_indices", []) if index >= 0})
        citation["chunk_indices"] = chunk_indices
        label_indices = chunk_indices
        if not label_indices:
            chunk_index = _safe_int(citation.get("chunk_index"), -1)
            if chunk_index >= 0:
                label_indices = [chunk_index]
        citation["source_label"] = _build_source_label(citation["document_name"], label_indices)

    return citations


def _build_numbered_context(source_entries: list[dict], citation_items: list[dict]) -> str:
    grouped_entries = _group_source_entries(source_entries)

    context_parts = []
    for citation in citation_items:
        group_key = _get_citation_item_group_key(citation)
        entries = grouped_entries.get(group_key, [])
        if not entries:
            continue

        chunk_sections = []
        seen_chunk_entries = set()
        for entry in entries:
            metadata = entry.get("metadata") or {}
            chunk_index = _safe_int(metadata.get("chunk_index"), 0)
            chunk_id = str(metadata.get("chunk_id") or "").strip()
            chunk_entry_key = chunk_id or f"idx:{chunk_index}"
            if chunk_entry_key in seen_chunk_entries:
                continue
            seen_chunk_entries.add(chunk_entry_key)

            page_content = str(entry.get("page_content") or "")
            if not page_content.strip():
                continue
            chunk_sections.append(f"(chunk {chunk_index})\n{page_content}")

        if not chunk_sections:
            continue

        joined_chunks = "\n\n".join(chunk_sections)

        context_parts.append(
            f"[{citation['citation_number']}] Source: {citation['document_name']}\n"
            f"{joined_chunks}"
        )

    return "\n\n".join(context_parts)


def _extract_cited_numbers(answer_text: str, max_citation_number: int) -> list[int]:
    if max_citation_number <= 0:
        return []

    content = answer_text or ""
    cited_numbers: set[int] = set()

    # Preferred markdown citation format: [n](#cite-n).
    for bracket_number, anchor_number in re.findall(r"\[(\d+)\]\(#cite-(\d+)\)", content):
        bracket_value = _safe_int(bracket_number, 0)
        anchor_value = _safe_int(anchor_number, 0)
        if bracket_value > 0:
            cited_numbers.add(bracket_value)
        if anchor_value > 0:
            cited_numbers.add(anchor_value)

    # Backward-compatible bracket references like [2].
    for match in re.findall(r"\[(\d+)\]", content):
        value = _safe_int(match, 0)
        if value > 0:
            cited_numbers.add(value)

    # Grouped references such as [1, 2] or [1;2].
    grouped_matches = re.findall(r"\[((?:\s*\d+\s*[,;]\s*)+\d+\s*)\]", content)
    for group in grouped_matches:
        for raw_value in re.split(r"[,;]", group):
            value = _safe_int(raw_value.strip(), 0)
            if value > 0:
                cited_numbers.add(value)

    # Support narrative references such as "cite 3" or "citation #4".
    for match in re.findall(r"\b(?:cite|citation|source)\s*#?\s*(\d+)\b", content, flags=re.IGNORECASE):
        value = _safe_int(match, 0)
        if value > 0:
            cited_numbers.add(value)

    return sorted(number for number in cited_numbers if 1 <= number <= max_citation_number)


def _refine_citation_items_for_numbers(
    citation_items: list[dict],
    source_entries: list[dict],
    answer_text: str,
    citation_numbers: list[int],
) -> list[dict]:
    if not citation_items or not citation_numbers:
        return []

    target_numbers = set(citation_numbers)
    grouped_entries = _group_source_entries(source_entries or [])
    refined_cited_items: list[dict] = []

    for citation in citation_items:
        citation_number = _safe_int(citation.get("citation_number"), 0)
        if citation_number not in target_numbers:
            continue

        refined_citation = dict(citation)
        if citation_number <= 0:
            refined_cited_items.append(refined_citation)
            continue

        group_key = _get_citation_item_group_key(refined_citation)
        entries = grouped_entries.get(group_key, [])
        if entries:
            focus_text = _extract_citation_focus_text(answer_text, citation_number)
            refined_snippet, refined_chunk_index = _select_best_entry_snippet(entries, focus_text, answer_text)
            if refined_snippet:
                refined_citation["snippet"] = refined_snippet
                refined_citation["chunk_index"] = refined_chunk_index

            refined_chunk_indices = sorted(
                {
                    _safe_int((entry.get("metadata") or {}).get("chunk_index"), -1)
                    for entry in entries
                    if _safe_int((entry.get("metadata") or {}).get("chunk_index"), -1) >= 0
                }
            )
            if refined_chunk_indices:
                refined_citation["chunk_indices"] = refined_chunk_indices
                document_name = str(
                    refined_citation.get("document_name")
                    or f"Source Document {citation_number}"
                )
                refined_citation["source_label"] = _build_source_label(document_name, refined_chunk_indices)

        refined_cited_items.append(refined_citation)

    return sorted(
        refined_cited_items,
        key=lambda citation: _safe_int(citation.get("citation_number"), 0),
    )


def _build_public_citation_items(citation_items: list[dict]) -> list[dict]:
    return [
        {
            "citation_number": citation["citation_number"],
            "document_id": citation.get("document_id", ""),
            "document_name": citation.get("document_name", ""),
            "snippet": citation.get("snippet", ""),
            "chunk_index": citation.get("chunk_index", 0),
            "chunk_indices": citation.get("chunk_indices"),
            "source_label": citation.get("source_label"),
        }
        for citation in citation_items
    ]


def _citation_event_payload(event_name: str, citation_items: list[dict], **extra) -> str:
    payload = {
        "items": _build_public_citation_items(citation_items),
        **extra,
    }
    return f"data: {event_name} {json.dumps(payload, ensure_ascii=False)}\n\n"


def _text_event_payload(text: str) -> str:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    encoded_lines = [f"data: {line}" if line else "data:" for line in lines]
    return "\n".join(encoded_lines) + "\n\n"


def _coerce_stream_text(chunk_content) -> str:
    def _coerce_mapping_text(payload: dict) -> str:
        for key in (
            "text",
            "content",
            "reasoning_content",
            "reasoning",
            "thinking",
            "output_text",
            "output",
            "response",
            "completion",
            "generated_text",
            "answer",
            "delta",
            "message",
            "parts",
            "choices",
            "candidates",
        ):
            value = payload.get(key)
            coerced = _coerce_stream_text(value)
            if coerced:
                return coerced

        for choice_key in ("delta", "message"):
            coerced = _coerce_stream_text(payload.get(choice_key))
            if coerced:
                return coerced

        # Fallback: scan likely textual fields for non-standard local provider payloads.
        candidate_parts: list[str] = []
        for key, value in payload.items():
            normalized_key = str(key or "").lower()
            if normalized_key in {
                "id",
                "object",
                "model",
                "role",
                "index",
                "created",
                "usage",
                "finish_reason",
                "system_fingerprint",
            }:
                continue

            if any(marker in normalized_key for marker in ("text", "content", "reason", "think", "message", "output", "completion", "answer")):
                coerced = _coerce_stream_text(value)
                if coerced:
                    candidate_parts.append(coerced)

        if candidate_parts:
            return "".join(candidate_parts)

        return ""

    if chunk_content is None:
        return ""

    if isinstance(chunk_content, str):
        return chunk_content

    if isinstance(chunk_content, (bytes, bytearray)):
        try:
            return chunk_content.decode("utf-8", errors="ignore")
        except Exception:
            return ""

    if isinstance(chunk_content, dict):
        return _coerce_mapping_text(chunk_content)

    if isinstance(chunk_content, (list, tuple)):
        parts: list[str] = []
        for item in chunk_content:
            coerced_item = _coerce_stream_text(item)
            if coerced_item:
                parts.append(coerced_item)

        return "".join(parts)

    text_attr = getattr(chunk_content, "text", None)
    if isinstance(text_attr, str) and text_attr:
        return text_attr

    for attr_name in (
        "reasoning_content",
        "reasoning",
        "thinking",
        "output_text",
        "completion",
        "message",
        "delta",
        "choices",
        "candidates",
        "parts",
        "output",
        "response",
    ):
        attr_value = getattr(chunk_content, attr_name, None)
        if attr_value is None or attr_value is chunk_content:
            continue

        coerced_attr_value = _coerce_stream_text(attr_value)
        if coerced_attr_value:
            return coerced_attr_value

    content_attr = getattr(chunk_content, "content", None)
    if content_attr is not None and content_attr is not chunk_content:
        coerced_content_attr = _coerce_stream_text(content_attr)
        if coerced_content_attr:
            return coerced_content_attr

    additional_kwargs = getattr(chunk_content, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        coerced_additional = _coerce_mapping_text(additional_kwargs)
        if coerced_additional:
            return coerced_additional

    response_metadata = getattr(chunk_content, "response_metadata", None)
    if isinstance(response_metadata, dict):
        coerced_response_meta = _coerce_mapping_text(response_metadata)
        if coerced_response_meta:
            return coerced_response_meta

    if isinstance(chunk_content, (int, float, bool)):
        return str(chunk_content)

    return ""


def _stream_llm_with_citations(
    llm,
    messages,
    citation_items: list[dict],
    source_entries: list[dict] | None = None,
    request: ChatRequest | None = None,
):
    full_text_parts: list[str] = []
    emitted_numbers: set[int] = set()

    def _invoke_fallback_text() -> str:
        invoked_text = ""
        try:
            response = llm.invoke(messages)
            response_content = getattr(response, "content", None)
            invoked_text = _coerce_stream_text(response_content if response_content is not None else response)
        except Exception:
            invoked_text = ""

        if invoked_text:
            return invoked_text

        provider = _normalize_provider_name(getattr(request, "api_provider", "") if request is not None else "")
        if provider == "local" and request is not None:
            local_http_text = _invoke_local_openai_compatible_http_fallback(request, messages)
            if local_http_text:
                return local_http_text

        return ""

    try:
        for chunk in llm.stream(messages):
            raw_chunk_content = getattr(chunk, "content", None)
            text_chunk = _coerce_stream_text(raw_chunk_content if raw_chunk_content is not None else chunk)
            if not text_chunk:
                text_chunk = _coerce_stream_text(chunk)
            if not text_chunk:
                continue

            full_text_parts.append(text_chunk)
            yield _text_event_payload(text_chunk)

            running_text = "".join(full_text_parts)
            cited_numbers = _extract_cited_numbers(running_text, len(citation_items))
            new_numbers = [number for number in cited_numbers if number not in emitted_numbers]
            if not new_numbers:
                continue

            delta_items = _refine_citation_items_for_numbers(
                citation_items,
                source_entries or [],
                running_text,
                new_numbers,
            )
            if not delta_items:
                continue

            emitted_numbers.update(
                number
                for number in (
                    _safe_int(item.get("citation_number"), 0)
                    for item in delta_items
                )
                if number > 0
            )

            yield _citation_event_payload(
                CITATION_EVENT_DELTA,
                delta_items,
                cited_numbers=sorted(emitted_numbers),
            )

    except Exception as stream_exc:
        partial_text = "".join(full_text_parts)
        partial_numbers = _extract_cited_numbers(partial_text, len(citation_items))
        partial_items = _refine_citation_items_for_numbers(
            citation_items,
            source_entries or [],
            partial_text,
            partial_numbers,
        )
        yield _citation_event_payload(
            CITATION_EVENT_PARTIAL,
            partial_items,
            reason="stream_error",
            error=str(stream_exc),
            cited_numbers=partial_numbers,
        )
        yield f"data: [STREAM_ERROR] {json.dumps({'message': str(stream_exc)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
        return

    full_text = "".join(full_text_parts)
    if not full_text.strip():
        fallback_text = _invoke_fallback_text()
        if fallback_text:
            full_text_parts.append(fallback_text)
            full_text = "".join(full_text_parts)
            yield _text_event_payload(fallback_text)

    if not full_text.strip():
        no_content_message = (
            "Model completed without visible text output. Try another local model, disable thinking mode, "
            "or switch LM Studio URL to its OpenAI-compatible /v1 endpoint."
        )
        yield f"data: [STREAM_ERROR] {json.dumps({'message': no_content_message}, ensure_ascii=False)}\n\n"

    cited_numbers = _extract_cited_numbers(full_text, len(citation_items))
    refined_cited_items = _refine_citation_items_for_numbers(
        citation_items,
        source_entries or [],
        full_text,
        cited_numbers,
    )
    yield _citation_event_payload(
        CITATION_EVENT_FULL,
        refined_cited_items,
        cited_numbers=cited_numbers,
    )
    yield "data: [DONE]\n\n"

def _is_model_not_found_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        ("not_found" in message or "not found" in message)
        and ("models/" in message or "generatecontent" in message)
    )


def _default_openai_model() -> str:
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def _default_openrouter_model() -> str:
    return os.getenv("OPENROUTER_MODEL", "openrouter/auto")


def _default_openai_compatible_model() -> str:
    return os.getenv("OPENAI_COMPATIBLE_MODEL", "gpt-4o-mini")


def _default_gemini_model() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-2.0-flash")


def _default_anthropic_model() -> str:
    return os.getenv("ANTHROPIC_MODEL", "claude-3-haiku-20240307")


def _default_cerebras_model() -> str:
    return os.getenv("CEREBRAS_MODEL", "llama-3.3-70b")


def get_default_cloud_model(provider: str) -> str | None:
    normalized = _normalize_provider_name(provider)
    if normalized == "openai":
        return _default_openai_model()
    if normalized == "openai_compatible":
        return _default_openai_compatible_model()
    if normalized == "openrouter":
        return _default_openrouter_model()
    if normalized == "gemini":
        return _default_gemini_model()
    if normalized == "anthropic":
        return _default_anthropic_model()
    if normalized == "cerebras":
        return _default_cerebras_model()
    return None


def _gemini_model_candidates(preferred_model: str | None = None) -> list[str]:
    configured_preferred = _default_gemini_model()
    env_fallbacks = [
        model.strip()
        for model in os.getenv("GEMINI_MODEL_FALLBACKS", "").split(",")
        if model.strip()
    ]

    defaults = [
        (preferred_model or "").strip(),
        configured_preferred,
        "gemini-2.0-flash",
        "gemini-1.5-flash-latest",
        "gemini-1.5-flash-002",
        "gemini-1.5-flash-001",
    ]

    deduped: list[str] = []
    for model in defaults + env_fallbacks:
        if model and model not in deduped:
            deduped.append(model)
    return deduped


def _normalize_openai_compatible_base_url(base_url: str) -> str:
    raw_base_url = (base_url or "").strip()
    if not raw_base_url:
        raise ValueError("OpenAI-compatible base URL is required.")

    parsed = urlparse(raw_base_url if "://" in raw_base_url else f"https://{raw_base_url}")
    if not parsed.netloc and parsed.path:
        parsed = urlparse(f"https://{raw_base_url}")

    host = parsed.hostname
    if not host:
        raise ValueError("Invalid OpenAI-compatible base URL.")

    scheme = parsed.scheme or "https"
    port_suffix = f":{parsed.port}" if parsed.port is not None else ""
    path = parsed.path.rstrip("/")
    if path == "/":
        path = ""

    return f"{scheme}://{host}{port_suffix}{path}"


def _normalize_local_openai_base_url(base_url: str) -> str:
    raw_base_url = (base_url or "").strip()
    if not raw_base_url:
        return ""

    parsed = urlparse(raw_base_url if "://" in raw_base_url else f"http://{raw_base_url}")
    if not parsed.netloc and parsed.path:
        parsed = urlparse(f"http://{raw_base_url}")

    host = parsed.hostname
    if not host:
        return raw_base_url.rstrip("/")

    scheme = parsed.scheme or "http"
    port_suffix = f":{parsed.port}" if parsed.port is not None else ""
    path = parsed.path.rstrip("/")

    replacements = (
        ("/api/v1/chat/completions", "/v1"),
        ("/api/v1/chat", "/v1"),
        ("/api/v1/models", "/v1"),
        ("/api/v1", "/v1"),
        ("/v1/chat/completions", "/v1"),
        ("/v1/models", "/v1"),
    )

    normalized_path = path
    for source_path, target_path in replacements:
        if normalized_path.endswith(source_path):
            normalized_path = normalized_path[: -len(source_path)] + target_path
            break

    if normalized_path == "/":
        normalized_path = ""

    return f"{scheme}://{host}{port_suffix}{normalized_path}"


def _message_role_for_openai(message) -> str:
    if isinstance(message, SystemMessage):
        return "system"
    if isinstance(message, HumanMessage):
        return "user"
    if isinstance(message, AIMessage):
        return "assistant"

    role_attr = str(getattr(message, "role", "") or "").strip().lower()
    if role_attr in {"system", "assistant", "user"}:
        return role_attr
    if role_attr in {"ai", "model"}:
        return "assistant"

    type_attr = str(getattr(message, "type", "") or "").strip().lower()
    if type_attr in {"system", "assistant", "human", "user", "ai"}:
        if type_attr == "human":
            return "user"
        if type_attr == "ai":
            return "assistant"
        return type_attr

    return "user"


def _serialize_messages_for_openai(messages) -> list[dict]:
    serialized: list[dict] = []
    for message in messages or []:
        content = _coerce_stream_text(getattr(message, "content", message))
        if not content:
            continue

        serialized.append(
            {
                "role": _message_role_for_openai(message),
                "content": content,
            }
        )

    return serialized


def _invoke_local_openai_compatible_http_fallback(request: ChatRequest, messages) -> str:
    local_url = (getattr(request, "local_model_url", "") or "").strip()
    local_model = (getattr(request, "local_model_name", "") or "").strip()
    if not local_url or not local_model:
        return ""

    if "/v1" not in local_url and "/api/v1" not in local_url:
        return ""

    normalized_base_url = _normalize_local_openai_base_url(local_url)
    if not normalized_base_url:
        return ""

    endpoint = f"{normalized_base_url.rstrip('/')}/chat/completions"
    serialized_messages = _serialize_messages_for_openai(messages)
    if not serialized_messages:
        return ""

    payload = {
        "model": local_model,
        "messages": serialized_messages,
        "stream": False,
    }

    try:
        response = httpx.post(endpoint, json=payload, timeout=45.0)
    except Exception:
        return ""

    if response.status_code >= 400:
        return ""

    try:
        response_payload = response.json()
    except ValueError:
        return ""

    return _coerce_stream_text(response_payload)


def get_llm_instance(request: ChatRequest, model_override: str | None = None):
    """Factory to instantiate the appropriate LLM based on provider."""
    provider = _normalize_provider_name(request.api_provider)
    api_key = request.api_key
    selected_cloud_model = (model_override or request.cloud_model or "").strip()

    if provider == "openai":
        if not api_key:
            raise ValueError("OpenAI API key is required.")
        return ChatOpenAI(
            api_key=api_key,
            model=selected_cloud_model or _default_openai_model(),
            streaming=True,
        )

    elif provider == "openrouter":
        if not api_key:
            raise ValueError("OpenRouter API key is required.")
        return ChatOpenAI(
            api_key=api_key,
            model=selected_cloud_model or _default_openrouter_model(),
            base_url="https://openrouter.ai/api/v1",
            streaming=True,
        )

    elif provider == "gemini":
        if not api_key:
            raise ValueError("Gemini API key is required.")
        gemini_model = selected_cloud_model or _default_gemini_model()
        return ChatGoogleGenerativeAI(
            google_api_key=api_key,
            model=gemini_model,
            streaming=True,
        )

    elif provider == "anthropic":
        if not api_key:
            raise ValueError("Anthropic API key is required.")
        return ChatAnthropic(
            api_key=api_key,
            model=selected_cloud_model or _default_anthropic_model(),
            streaming=True,
        )

    elif provider == "cerebras":
        if not api_key:
            raise ValueError("Cerebras API key is required.")
        cerebras_model = selected_cloud_model or _default_cerebras_model()
        return ChatOpenAI(
            api_key=api_key,
            model=cerebras_model,
            base_url="https://api.cerebras.ai/v1",
            streaming=True,
        )

    elif provider == "openai_compatible":
        if not api_key:
            raise ValueError("OpenAI-compatible API key is required.")

        compatible_base_url = _normalize_openai_compatible_base_url(
            request.cloud_base_url or os.getenv("OPENAI_COMPATIBLE_BASE_URL") or ""
        )
        compatible_model = selected_cloud_model or _default_openai_compatible_model()
        if not compatible_model:
            raise ValueError("OpenAI-compatible model name is required.")

        return ChatOpenAI(
            api_key=api_key,
            model=compatible_model,
            base_url=compatible_base_url,
            streaming=True,
        )

    elif provider == "local":
        # Supports both Ollama and OpenAI-compatible servers (LM Studio, LocalAI, etc.)
        url = (request.local_model_url or os.getenv("LOCAL_MODEL_URL") or "").strip()
        model_name = (request.local_model_name or os.getenv("LOCAL_MODEL_NAME") or "").strip()

        if not url or not model_name:
            raise ValueError("Local model URL and model name are required.")

        if "/v1" in url or "/api/v1" in url:
            normalized_local_url = _normalize_local_openai_base_url(url)
            # LM Studio / LocalAI / vLLM (OpenAI compatible)
            return ChatOpenAI(
                base_url=normalized_local_url,
                api_key="not-needed", # Local servers usually don't need this
                model=model_name,
                streaming=True
            )
        else:
            # Assumes Ollama
            base_url = url.replace("/api/generate", "")
            return Ollama(model=model_name, base_url=base_url)

    else:
        raise ValueError(f"Unsupported API Provider: {provider}")

def generate_chat_stream(request: ChatRequest):
    """
    Retrieves context from VectorDB and yields SSE formatted chunks from the LLM.
    """
    # 1. Setup Vector DB using ChromaDB's ONNX embedding function (no PyTorch required).
    _embed_fn = embedding_functions.DefaultEmbeddingFunction()
    chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
    collection = chroma_client.get_or_create_collection(
        name="notestack_docs",
        embedding_function=_embed_fn,
    )

    # 2. Extract user query and retrieve context
    user_query = request.messages[-1].text if request.messages else ""
    if not user_query:
        yield "data: No query provided.\n\n"
        return

    # Similarity search filtered by the requested document IDs.
    retrieved_docs = _retrieve_docs_for_query_native(
        collection, _embed_fn, user_query, request.document_ids
    )

    source_entries = _build_source_entries_from_retrieved_docs(retrieved_docs)

    # Fallback for freshly uploaded files that may not be embedded yet.
    if not source_entries and request.document_ids:
        source_entries = _load_direct_file_context_entries(request.document_ids)

    citation_items = _build_citation_items(source_entries, user_query)
    context = _build_numbered_context(source_entries, citation_items)

    provider = _normalize_provider_name(request.api_provider)

    # 3. Construct System Prompt
    base_instructions = request.system_instructions or DEFAULT_BASE_INSTRUCTIONS
    citation_instructions = (
        "Citation rules:\n"
        "- Cite factual claims using markdown links in this exact format: [n](#cite-n).\n"
        "- If one claim has multiple supporting sources, cite each separately as [1](#cite-1), [2](#cite-2).\n"
        "- Use only citation numbers that appear in Document context.\n"
        "- Do not invent citation numbers.\n"
    )

    system_prompt = (
        f"{base_instructions}\n\n"
        f"{citation_instructions}\n"
        "Document context:\n"
        f"{context if context else '[No relevant document chunks were retrieved.]'}"
    )

    # 4. Construct Message History
    if provider == "local":
        # Some local chat templates (including Gemma variants) follow instructions
        # more reliably when context is embedded directly in the user prompt.
        local_prompt = _build_local_rag_prompt(
            base_instructions=base_instructions,
            context=context,
            history_messages=request.messages[:-1],
            user_query=user_query,
            provider=provider,
        )
        messages = [HumanMessage(content=local_prompt)]
    else:
        messages = [SystemMessage(content=system_prompt)]
        for msg in request.messages[:-1]:
            if msg.role == 'user':
                messages.append(HumanMessage(content=msg.text))
            else:
                messages.append(AIMessage(content=msg.text))

        messages.append(HumanMessage(content=user_query))

    # 5. Instantiate LLM and Stream
    try:
        if provider == "gemini":
            last_error: Exception | None = None
            for model_name in _gemini_model_candidates(request.cloud_model):
                try:
                    llm = get_llm_instance(request, model_override=model_name)
                    yield from _stream_llm_with_citations(llm, messages, citation_items, source_entries, request=request)
                    return
                except Exception as model_exc:
                    last_error = model_exc
                    if _is_model_not_found_error(model_exc):
                        # Try next configured Gemini model.
                        continue
                    raise

            if last_error:
                raise ValueError(
                    "No supported Gemini model was found for this API key/version. "
                    "Set GEMINI_MODEL or GEMINI_MODEL_FALLBACKS in backend/.env. "
                    f"Last error: {last_error}"
                )
            raise ValueError("No Gemini model candidates configured.")

        llm = get_llm_instance(request)
        yield from _stream_llm_with_citations(llm, messages, citation_items, source_entries, request=request)

    except Exception as e:
        yield f"data: Error: {str(e)}\n\n"
