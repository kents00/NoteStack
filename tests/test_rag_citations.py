import json
import re
import sys
import types
import uuid

import pytest


def _register_stub_module(module_name: str, **attrs) -> None:
    module = types.ModuleType(module_name)
    for name, value in attrs.items():
        setattr(module, name, value)
    sys.modules[module_name] = module

    if "." in module_name:
        parent_name, child_name = module_name.rsplit(".", 1)
        parent_module = sys.modules.get(parent_name)
        if parent_module is None:
            parent_module = types.ModuleType(parent_name)
            sys.modules[parent_name] = parent_module
        setattr(parent_module, child_name, module)


class _DummyDependency:
    def __init__(self, *args, **kwargs):
        pass


class _DummyMessage:
    def __init__(self, content=None):
        self.content = content


# Keep tests isolated from optional runtime dependencies; citation helpers tested here do not use these classes.
_register_stub_module("langchain_openai", ChatOpenAI=_DummyDependency)
_register_stub_module("langchain_huggingface", HuggingFaceEmbeddings=_DummyDependency)
_register_stub_module("langchain_google_genai", ChatGoogleGenerativeAI=_DummyDependency)
_register_stub_module("langchain_anthropic", ChatAnthropic=_DummyDependency)
_register_stub_module("langchain_community")
_register_stub_module("langchain_community.llms", Ollama=_DummyDependency)
_register_stub_module("langchain_community.vectorstores", Chroma=_DummyDependency)
_register_stub_module(
    "langchain_core.messages",
    HumanMessage=_DummyMessage,
    AIMessage=_DummyMessage,
    SystemMessage=_DummyMessage,
)

from app.services import rag


def _entry(page_content: str, **metadata):
    return {"page_content": page_content, "metadata": metadata}


def test_normalize_context_text_preserves_markdown_structure() -> None:
    raw_text = (
        "# Heading\r\n\r\n"
        "- Item one\r\n"
        "    - Nested item\r\n\r\n"
        "Paragraph one.\r\n\r\n\r\n\r\n"
        "Paragraph two."
    )

    normalized = rag._normalize_context_text(raw_text)

    assert normalized.startswith("# Heading\n\n- Item one\n    - Nested item")
    assert "\n\n\n\n" not in normalized
    assert "Paragraph one.\n\n\nParagraph two." in normalized


def test_load_direct_file_context_entries_preserves_markdown_newlines(monkeypatch) -> None:
    document_id = uuid.uuid4()

    class _FakeDoc:
        def __init__(self):
            self.id = document_id
            self.s3_key = "uploads/mock.md"
            self.mime_type = "text/markdown"
            self.name = "mock.md"

    class _FakeQuery:
        def __init__(self, docs):
            self.docs = docs

        def filter(self, *_args, **_kwargs):
            return self

        def limit(self, _value):
            return self

        def all(self):
            return self.docs

    class _FakeSession:
        def __init__(self, docs):
            self.docs = docs
            self.closed = False

        def query(self, _model):
            return _FakeQuery(self.docs)

        def close(self):
            self.closed = True

    fake_session = _FakeSession([_FakeDoc()])

    monkeypatch.setattr(rag, "SessionLocal", lambda: fake_session)
    monkeypatch.setattr(rag, "get_file_path", lambda _key: "/tmp/mock.md")
    monkeypatch.setattr(
        rag,
        "extract_text",
        lambda _path, _mime: "# Heading\n\n- first item\n- second item",
    )

    entries = rag._load_direct_file_context_entries([str(document_id)], max_docs=1, max_chars_per_doc=4000)

    assert len(entries) == 1
    assert entries[0]["metadata"]["document_id"] == str(document_id)
    assert entries[0]["page_content"] == "# Heading\n\n- first item\n- second item"
    assert fake_session.closed is True


def test_build_citation_items_keeps_same_name_files_separate_via_chunk_id_prefix() -> None:
    source_entries = [
        _entry(
            "alpha file chunk zero",
            name="report.pdf",
            chunk_id="doc-alpha:0",
            chunk_index=0,
        ),
        _entry(
            "bravo file chunk zero",
            name="report.pdf",
            chunk_id="doc-bravo:0",
            chunk_index=0,
        ),
        _entry(
            "bravo file chunk one",
            name="report.pdf",
            chunk_id="doc-bravo:1",
            chunk_index=1,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="bravo chunk")

    assert len(citation_items) == 3
    assert citation_items[0]["citation_number"] == 1
    assert citation_items[1]["citation_number"] == 2
    assert citation_items[2]["citation_number"] == 3
    assert citation_items[0]["chunk_indices"] == [0]
    assert citation_items[1]["chunk_indices"] == [0]
    assert citation_items[2]["chunk_indices"] == [1]


def test_build_numbered_context_maps_second_citation_to_correct_file_content() -> None:
    source_entries = [
        _entry(
            "alpha file unique sentence",
            name="report.pdf",
            chunk_id="doc-alpha:0",
            chunk_index=0,
        ),
        _entry(
            "bravo file unique sentence part one",
            name="report.pdf",
            chunk_id="doc-bravo:0",
            chunk_index=0,
        ),
        _entry(
            "bravo file unique sentence part two",
            name="report.pdf",
            chunk_id="doc-bravo:1",
            chunk_index=1,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="bravo")
    context = rag._build_numbered_context(source_entries, citation_items)

    assert "[1] Source:" in context
    assert "[2] Source:" in context
    assert "[3] Source:" in context

    first_section, tail = context.split("[2] Source:", 1)
    second_section, third_section = tail.split("[3] Source:", 1)

    assert "alpha file unique sentence" in first_section
    assert "bravo file unique sentence part one" not in first_section
    assert "bravo file unique sentence part two" not in first_section

    assert "bravo file unique sentence part one" in second_section
    assert "bravo file unique sentence part two" not in second_section

    assert "bravo file unique sentence part two" in third_section
    assert "bravo file unique sentence part one" not in third_section
    assert "alpha file unique sentence" not in third_section


class _FakeChunk:
    def __init__(self, content: str):
        self.content = content


class _FakeLLM:
    def stream(self, _messages):
        yield _FakeChunk("Answer uses only citation [2].")


def test_stream_citations_filters_to_used_numbers_and_hides_internal_group_key() -> None:
    citation_items = [
        {
            "citation_number": 1,
            "_group_key": "id:doc-alpha",
            "document_id": "doc-alpha",
            "document_name": "alpha.pdf",
            "snippet": "alpha snippet",
            "chunk_index": 0,
            "chunk_indices": [0],
            "source_label": "alpha.pdf (Chunk 1)",
        },
        {
            "citation_number": 2,
            "_group_key": "id:doc-bravo",
            "document_id": "doc-bravo",
            "document_name": "bravo.pdf",
            "snippet": "bravo snippet",
            "chunk_index": 1,
            "chunk_indices": [0, 1],
            "source_label": "bravo.pdf (Chunks 1, 2)",
        },
    ]

    events = list(rag._stream_llm_with_citations(_FakeLLM(), [], citation_items))
    citation_event = next(event for event in events if event.startswith("data: [CITATIONS] "))

    payload = json.loads(citation_event.removeprefix("data: [CITATIONS] ").strip())
    assert "items" in payload
    assert len(payload["items"]) == 1

    item = payload["items"][0]
    assert item["citation_number"] == 2
    assert item["document_id"] == "doc-bravo"
    assert item["document_name"] == "bravo.pdf"
    assert "_group_key" not in item


class _FocusLLM:
    def stream(self, _messages):
        yield _FakeChunk("The classifier reached 95% accuracy on the evaluation set [2].")


def test_stream_citations_refines_snippet_from_answer_focus_text() -> None:
    source_entries = [
        _entry(
            "1*, Daig, Charles S.2, Pabatang, Ivy Joy M.3, and multiple author emails at sample@domain.com",
            document_id="doc-1",
            name="paper.pdf",
            chunk_id="doc-1:0",
            chunk_index=0,
        ),
        _entry(
            "The study reports 95% accuracy for classifying malware in the evaluation benchmark dataset.",
            document_id="doc-1",
            name="paper.pdf",
            chunk_id="doc-1:1",
            chunk_index=1,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="evaluation accuracy")

    events = list(rag._stream_llm_with_citations(_FocusLLM(), [], citation_items, source_entries))
    citation_event = next(event for event in events if event.startswith("data: [CITATIONS] "))

    payload = json.loads(citation_event.removeprefix("data: [CITATIONS] ").strip())
    item = payload["items"][0]

    assert "accuracy" in item["snippet"].lower()
    assert item["chunk_index"] == 1
    assert item["citation_number"] == 2


def test_get_default_cloud_model_returns_openrouter_env_override(monkeypatch) -> None:
    monkeypatch.setenv("OPENROUTER_MODEL", "openrouter/meta-llama/llama-3.3-70b-instruct")
    assert rag.get_default_cloud_model("openrouter") == "openrouter/meta-llama/llama-3.3-70b-instruct"


def test_get_default_cloud_model_returns_openai_compatible_env_override(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_COMPATIBLE_MODEL", "openai-compatible/custom-model")
    assert rag.get_default_cloud_model("openai_compatible") == "openai-compatible/custom-model"


def test_get_llm_instance_openrouter_uses_openai_compatible_base_url(monkeypatch) -> None:
    captured_kwargs: dict = {}

    class _CaptureChatOpenAI:
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)

    monkeypatch.setattr(rag, "ChatOpenAI", _CaptureChatOpenAI)

    request = types.SimpleNamespace(
        api_provider="openrouter",
        api_key="sk-or-v1-exampleexampleexample",
        cloud_model="openrouter/auto",
        local_model_url=None,
        local_model_name=None,
    )

    client = rag.get_llm_instance(request)

    assert isinstance(client, _CaptureChatOpenAI)
    assert captured_kwargs["api_key"] == "sk-or-v1-exampleexampleexample"
    assert captured_kwargs["model"] == "openrouter/auto"
    assert captured_kwargs["base_url"] == "https://openrouter.ai/api/v1"
    assert captured_kwargs["streaming"] is True


def test_get_llm_instance_openai_compatible_uses_custom_base_url(monkeypatch) -> None:
    captured_kwargs: dict = {}

    class _CaptureChatOpenAI:
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)

    monkeypatch.setattr(rag, "ChatOpenAI", _CaptureChatOpenAI)

    request = types.SimpleNamespace(
        api_provider="openai_compatible",
        api_key="test-openai-compatible-key-123456",
        cloud_model="meta-llama/test-8b",
        cloud_base_url="api.groq.com/openai/v1",
        local_model_url=None,
        local_model_name=None,
    )

    client = rag.get_llm_instance(request)

    assert isinstance(client, _CaptureChatOpenAI)
    assert captured_kwargs["api_key"] == "test-openai-compatible-key-123456"
    assert captured_kwargs["model"] == "meta-llama/test-8b"
    assert captured_kwargs["base_url"] == "https://api.groq.com/openai/v1"
    assert captured_kwargs["streaming"] is True


def test_get_llm_instance_openrouter_requires_api_key() -> None:
    request = types.SimpleNamespace(
        api_provider="openrouter",
        api_key=None,
        cloud_model="openrouter/auto",
        local_model_url=None,
        local_model_name=None,
    )

    with pytest.raises(ValueError, match="OpenRouter API key is required"):
        rag.get_llm_instance(request)


def test_get_llm_instance_openai_compatible_requires_base_url() -> None:
    request = types.SimpleNamespace(
        api_provider="openai_compatible",
        api_key="test-openai-compatible-key-123456",
        cloud_model="meta-llama/test-8b",
        cloud_base_url=None,
        local_model_url=None,
        local_model_name=None,
    )

    with pytest.raises(ValueError, match="base URL is required"):
        rag.get_llm_instance(request)


def test_build_citation_items_replaces_low_signal_header_with_clean_chunk() -> None:
    source_entries = [
        _entry(
            "Lapura7 1,2,3,4,5,6,7 University of Science Mail ID: a@ustp.edu.ph, b@ustp.edu.ph this section compares retrieval approaches",
            document_id="doc-2",
            name="comparison.pdf",
            chunk_id="doc-2:0",
            chunk_index=0,
        ),
        _entry(
            "Dense retrieval improved precision and reduced hallucinations during side-by-side paper comparison.",
            document_id="doc-2",
            name="comparison.pdf",
            chunk_id="doc-2:1",
            chunk_index=1,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="compare retrieval approaches")

    assert len(citation_items) == 2

    noisy_chunk_citation = next(
        citation
        for citation in citation_items
        if citation["chunk_index"] == 0
    )

    snippet = noisy_chunk_citation["snippet"].lower()
    assert "@" not in snippet
    assert "mail id" not in snippet
    assert "retrieval" in snippet


def test_select_best_entry_snippet_prefers_clean_entry_when_header_is_noisy() -> None:
    entries = [
        _entry(
            "Lapura7 1,2,3,4,5,6,7 University of Science and Technology Mail ID: jane@ustp.edu.ph, mark@ustp.edu.ph this study compares retrieval methods",
            document_id="doc-3",
            name="paper.pdf",
            chunk_id="doc-3:0",
            chunk_index=0,
        ),
        _entry(
            "Embedding reranking improved precision in the comparative retrieval benchmark.",
            document_id="doc-3",
            name="paper.pdf",
            chunk_id="doc-3:1",
            chunk_index=1,
        ),
    ]

    snippet, chunk_index = rag._select_best_entry_snippet(
        entries,
        focus_text="The study compares retrieval methods [1].",
        fallback_text="compare retrieval methods",
    )

    lowered = snippet.lower()
    assert chunk_index in (0, 1)
    assert "retrieval" in lowered
    assert "@" not in lowered


def test_extract_reference_snippet_can_skip_noisy_header_within_single_chunk() -> None:
    noisy_then_relevant = (
        "Lapura7 1,2,3,4,5,6,7 University of Science and Technology of Southern Philippines "
        "Mail ID: jane.ballard@ustp.edu.ph, mark.embodo@ustp.edu.ph, jellygrace@ustp.edu.ph "
        "This section reports that stakeholders showed high acceptance of VMGO objectives "
        "across all surveyed indicators with consistently positive ratings."
    )

    snippet = rag._extract_reference_snippet(
        page_content=noisy_then_relevant,
        query_text="acceptance of vmgo objectives",
    )

    lowered = snippet.lower()
    assert "acceptance of vmgo objectives" in lowered
    assert "@ustp.edu.ph" not in lowered
    assert "mail id" not in lowered


class _DeltaLLM:
    def stream(self, _messages):
        yield _FakeChunk("First finding from source one [1]. ")
        yield _FakeChunk("Second finding from source two [2].")


def test_stream_citations_emits_incremental_deltas_and_final_snapshot() -> None:
    source_entries = [
        _entry(
            "Source one provides the first finding.",
            document_id="doc-1",
            name="alpha.pdf",
            chunk_id="doc-1:0",
            chunk_index=0,
        ),
        _entry(
            "Source two provides the second finding.",
            document_id="doc-2",
            name="bravo.pdf",
            chunk_id="doc-2:0",
            chunk_index=0,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="first second finding")
    events = list(rag._stream_llm_with_citations(_DeltaLLM(), [], citation_items, source_entries))

    delta_events = [event for event in events if event.startswith("data: [CITATIONS_DELTA] ")]
    assert len(delta_events) >= 2

    first_delta_payload = json.loads(delta_events[0].removeprefix("data: [CITATIONS_DELTA] ").strip())
    second_delta_payload = json.loads(delta_events[1].removeprefix("data: [CITATIONS_DELTA] ").strip())

    assert first_delta_payload["items"][0]["citation_number"] == 1
    assert second_delta_payload["items"][0]["citation_number"] == 2

    final_event = next(event for event in events if event.startswith("data: [CITATIONS] "))
    final_payload = json.loads(final_event.removeprefix("data: [CITATIONS] ").strip())
    assert [item["citation_number"] for item in final_payload["items"]] == [1, 2]


class _FailingLLM:
    def stream(self, _messages):
        yield _FakeChunk("Partial answer cites [1].")
        raise RuntimeError("stream exploded")


def test_stream_citations_emits_partial_payload_when_stream_fails() -> None:
    source_entries = [
        _entry(
            "This is the source content for citation one.",
            document_id="doc-1",
            name="alpha.pdf",
            chunk_id="doc-1:0",
            chunk_index=0,
        )
    ]
    citation_items = rag._build_citation_items(source_entries, query_text="source content")

    events = list(rag._stream_llm_with_citations(_FailingLLM(), [], citation_items, source_entries))
    partial_event = next(event for event in events if event.startswith("data: [CITATIONS_PARTIAL] "))
    partial_payload = json.loads(partial_event.removeprefix("data: [CITATIONS_PARTIAL] ").strip())

    assert partial_payload.get("reason") == "stream_error"
    assert [item["citation_number"] for item in partial_payload["items"]] == [1]
    assert events[-1] == "data: [DONE]\n\n"


class _ThreeCitationLLM:
    def stream(self, _messages):
        yield _FakeChunk("Comparison found findings in [1], [2], and [3].")


def test_stream_citations_three_sources_keep_stable_number_mapping() -> None:
    source_entries = [
        _entry(
            "Document A evidence sentence for criterion one.",
            document_id="doc-a",
            name="alpha.pdf",
            chunk_id="doc-a:0",
            chunk_index=0,
        ),
        _entry(
            "Document B evidence sentence for criterion two.",
            document_id="doc-b",
            name="bravo.pdf",
            chunk_id="doc-b:0",
            chunk_index=0,
        ),
        _entry(
            "Document C evidence sentence for criterion three.",
            document_id="doc-c",
            name="charlie.pdf",
            chunk_id="doc-c:0",
            chunk_index=0,
        ),
    ]

    citation_items = rag._build_citation_items(source_entries, query_text="compare criterion one two three")
    events = list(rag._stream_llm_with_citations(_ThreeCitationLLM(), [], citation_items, source_entries))

    final_event = next(event for event in events if event.startswith("data: [CITATIONS] "))
    payload = json.loads(final_event.removeprefix("data: [CITATIONS] ").strip())

    assert [item["citation_number"] for item in payload["items"]] == [1, 2, 3]
    assert [item["document_id"] for item in payload["items"]] == ["doc-a", "doc-b", "doc-c"]


class _MultilineChunkLLM:
    def stream(self, _messages):
        yield _FakeChunk("### Heading\n\n- item one\n- item two")


def test_stream_llm_encodes_multiline_text_as_valid_sse_data_lines() -> None:
    events = list(rag._stream_llm_with_citations(_MultilineChunkLLM(), [], []))

    assert events[0] == "data: ### Heading\ndata:\ndata: - item one\ndata: - item two\n\n"


class _EmptyStreamInvokeLLM:
    def stream(self, _messages):
        return iter(())

    def invoke(self, _messages):
        return _FakeChunk("Fallback answer uses citation [1].")


def test_stream_llm_falls_back_to_invoke_when_stream_has_no_text() -> None:
    citation_items = [
        {
            "citation_number": 1,
            "_group_key": "id:doc-alpha",
            "document_id": "doc-alpha",
            "document_name": "alpha.pdf",
            "snippet": "alpha snippet",
            "chunk_index": 0,
            "chunk_indices": [0],
            "source_label": "alpha.pdf (Chunk 1)",
        },
    ]

    events = list(rag._stream_llm_with_citations(_EmptyStreamInvokeLLM(), [], citation_items))

    assert events[0] == "data: Fallback answer uses citation [1].\n\n"

    citation_event = next(event for event in events if event.startswith("data: [CITATIONS] "))
    payload = json.loads(citation_event.removeprefix("data: [CITATIONS] ").strip())
    assert [item["citation_number"] for item in payload["items"]] == [1]


class _NoTextLLM:
    def stream(self, _messages):
        return iter(())

    def invoke(self, _messages):
        return _FakeChunk("")


def test_stream_llm_emits_stream_error_when_no_visible_text_after_fallback() -> None:
    events = list(rag._stream_llm_with_citations(_NoTextLLM(), [], []))

    assert any(event.startswith("data: [STREAM_ERROR] ") for event in events)
    assert events[-1] == "data: [DONE]\n\n"


class _NoTextLocalLLM:
    def stream(self, _messages):
        return iter(())

    def invoke(self, _messages):
        return _FakeChunk("")


def test_stream_llm_uses_local_http_fallback_when_invoke_has_no_visible_text(monkeypatch) -> None:
    citation_items = [
        {
            "citation_number": 1,
            "_group_key": "id:doc-alpha",
            "document_id": "doc-alpha",
            "document_name": "alpha.pdf",
            "snippet": "alpha snippet",
            "chunk_index": 0,
            "chunk_indices": [0],
            "source_label": "alpha.pdf (Chunk 1)",
        },
    ]

    request = types.SimpleNamespace(
        api_provider="local",
        local_model_url="http://127.0.0.1:1234/api/v1",
        local_model_name="qwen/qwen3.5-9b",
    )

    monkeypatch.setattr(
        rag,
        "_invoke_local_openai_compatible_http_fallback",
        lambda _request, _messages: "Recovered local output [1].",
    )

    events = list(rag._stream_llm_with_citations(_NoTextLocalLLM(), [], citation_items, request=request))

    assert events[0] == "data: Recovered local output [1].\n\n"
    assert not any(event.startswith("data: [STREAM_ERROR] ") for event in events)


def test_invoke_local_openai_compatible_http_fallback_parses_chat_completions(monkeypatch) -> None:
    captured_request: dict = {}

    class _FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "HTTP fallback content.",
                        }
                    }
                ]
            }

    def _fake_post(url, json=None, timeout=None):
        captured_request["url"] = url
        captured_request["json"] = json
        captured_request["timeout"] = timeout
        return _FakeResponse()

    monkeypatch.setattr(rag.httpx, "post", _fake_post)

    request = types.SimpleNamespace(
        local_model_url="http://127.0.0.1:1234/api/v1",
        local_model_name="qwen/qwen3.5-9b",
    )
    messages = [types.SimpleNamespace(role="user", content="Explain the findings.")]

    recovered = rag._invoke_local_openai_compatible_http_fallback(request, messages)

    assert recovered == "HTTP fallback content."
    assert captured_request["url"] == "http://127.0.0.1:1234/v1/chat/completions"
    assert captured_request["json"]["model"] == "qwen/qwen3.5-9b"
    assert captured_request["json"]["messages"][0]["role"] == "user"


def test_truncate_citation_snippet_truncates_on_word_boundary_for_long_text() -> None:
    long_text = " ".join(["evidence"] * 140)

    snippet = rag._truncate_citation_snippet(long_text)

    assert snippet.endswith("...")
    assert len(snippet) <= rag.MAX_TARGET_CITATION_SNIPPET_CHARS + 3
    assert len(snippet) >= rag.MIN_CITATION_SNIPPET_CHARS

    last_token = snippet.removesuffix("...").split()[-1]
    assert re.fullmatch(r"[a-zA-Z0-9]+", last_token)


def test_generate_snippet_candidates_keeps_common_abbreviations_intact() -> None:
    text = (
        "Dr. Santos reviewed U.S. program metrics for baseline alignment. "
        "The report found improved retention after intervention."
    )

    candidates = rag._generate_snippet_candidates(text)

    assert any(
        "Dr. Santos reviewed U.S. program metrics for baseline alignment." in candidate
        for candidate in candidates
    )


def test_truncate_citation_snippet_repairs_glued_connector_words() -> None:
    snippet = (
        "The participants were selected both purposivelyand randomly to ensure "
        "representation across the cohort."
    )

    repaired = rag._truncate_citation_snippet(snippet)

    assert "purposively and randomly" in repaired.lower()


def test_truncate_citation_snippet_does_not_split_normal_words() -> None:
    snippet = "Students understand outcomes and align actions with the mission statement."

    repaired = rag._truncate_citation_snippet(snippet)

    assert "understand outcomes" in repaired.lower()


def test_extract_cited_numbers_supports_markdown_links_and_narrative_references() -> None:
    answer_text = (
        "### Findings\n"
        "Primary evidence [1](#cite-1) confirms baseline impact. "
        "The follow-up cites source 2 and citation #3 for cross-checking."
    )

    cited_numbers = rag._extract_cited_numbers(answer_text, 3)

    assert cited_numbers == [1, 2, 3]


def test_extract_cited_numbers_supports_grouped_bracket_references() -> None:
    answer_text = "Evidence appears in [1, 2] and [3;4], while [8] is out of range."

    cited_numbers = rag._extract_cited_numbers(answer_text, 4)

    assert cited_numbers == [1, 2, 3, 4]


def test_coerce_stream_text_handles_nested_openai_style_payload() -> None:
    chunk_payload = {
        "choices": [
            {
                "delta": {
                    "content": [
                        {"type": "text", "text": "### Direct Answer\n"},
                        {"type": "text", "text": "- **Evidence** item"},
                    ]
                }
            }
        ]
    }

    extracted = rag._coerce_stream_text(chunk_payload)

    assert extracted == "### Direct Answer\n- **Evidence** item"


def test_coerce_stream_text_handles_reasoning_and_thinking_keys() -> None:
    chunk_payload = {
        "choices": [
            {
                "delta": {
                    "thinking": "The model is reasoning.",
                }
            }
        ]
    }

    extracted = rag._coerce_stream_text(chunk_payload)

    assert extracted == "The model is reasoning."


def test_coerce_stream_text_handles_response_wrapped_output() -> None:
    chunk_payload = {
        "response": {
            "output": [
                {
                    "content": [
                        {"type": "output_text", "text": "Visible answer text."},
                    ]
                }
            ]
        }
    }

    extracted = rag._coerce_stream_text(chunk_payload)

    assert extracted == "Visible answer text."


def test_get_llm_instance_local_normalizes_api_v1_base_url(monkeypatch) -> None:
    captured_kwargs: dict = {}

    class _CaptureChatOpenAI:
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)

    monkeypatch.setattr(rag, "ChatOpenAI", _CaptureChatOpenAI)

    request = types.SimpleNamespace(
        api_provider="local",
        api_key=None,
        cloud_model=None,
        cloud_base_url=None,
        local_model_url="http://127.0.0.1:1234/api/v1",
        local_model_name="qwen/qwen3.5-9b",
    )

    client = rag.get_llm_instance(request)

    assert isinstance(client, _CaptureChatOpenAI)
    assert captured_kwargs["base_url"] == "http://127.0.0.1:1234/v1"
    assert captured_kwargs["model"] == "qwen/qwen3.5-9b"
    assert captured_kwargs["streaming"] is True


def test_truncate_citation_snippet_preserves_markdown_tokens_and_line_breaks() -> None:
    snippet = (
        "### Key Evidence\n\n"
        "- **Finding:** The intervention improved retention by 18%.\n"
        "- `metric_2` remained stable across cohorts."
    )

    truncated = rag._truncate_citation_snippet(snippet)

    assert "### Key Evidence" in truncated
    assert "\n- **Finding:**" in truncated
    assert "`metric_2`" in truncated


def test_get_default_cloud_model_supports_provider_aliases(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest")

    assert rag.get_default_cloud_model("chatgpt") == "gpt-4.1-mini"
    assert rag.get_default_cloud_model("claude") == "claude-3-5-haiku-latest"


def test_get_local_prompt_budget_tokens_honors_explicit_override(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_PROMPT_MAX_TOKENS", "1024")

    assert rag._get_local_prompt_budget_tokens() == 1024


def test_build_local_rag_prompt_trims_for_small_context_budget(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONTEXT_LENGTH", "512")
    monkeypatch.setenv("LOCAL_PROMPT_TOKEN_MARGIN", "128")
    monkeypatch.delenv("LOCAL_PROMPT_MAX_TOKENS", raising=False)

    history_messages = [
        types.SimpleNamespace(role="user", text=f"User turn {i}: " + ("details " * 80))
        for i in range(1, 6)
    ] + [
        types.SimpleNamespace(role="assistant", text=f"Assistant turn {i}: " + ("analysis " * 80))
        for i in range(1, 6)
    ]

    context = "\n\n".join(
        f"[{i}] Source: document-{i}.pdf\n(chunk {i})\n" + ("evidence sentence " * 120)
        for i in range(1, 10)
    )
    user_query = "Summarize key evidence and compare findings across all sources."

    prompt = rag._build_local_rag_prompt(
        base_instructions=rag.DEFAULT_BASE_INSTRUCTIONS,
        context=context,
        history_messages=history_messages,
        user_query=user_query,
        provider="local",
    )

    budget = rag._get_local_prompt_budget_tokens()
    assert rag._approx_token_count(prompt) <= budget
    assert "USER QUESTION:" in prompt
    assert "DOCUMENT CONTEXT:" in prompt
    assert "truncated to fit local model context" in prompt.lower()
