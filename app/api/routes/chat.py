from datetime import datetime
import uuid
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
import httpx

from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.chat_message import ChatMessage
from app.models.chat_session import ChatSession
from app.schemas.chat import (
    ChatMessageCreate,
    ChatMessageResponse,
    ChatRequest,
    ChatSessionCreate,
    ChatSessionResponse,
    CloudProviderValidationRequest,
    CloudProviderValidationResponse,
    LocalLLMDiscoveryResponse,
    MessageFeedbackUpdate,
)
from app.services.rag import generate_chat_stream, get_default_cloud_model
from app.api.deps import get_current_user
from app.models.user import User

router = APIRouter()
CLOUD_PROVIDERS = {"gemini", "openai", "openrouter", "anthropic", "cerebras", "openai_compatible"}


def _get_owned_session(db: Session, session_id: str, user_id) -> ChatSession:
    session = (
        db.query(ChatSession)
        .filter(ChatSession.id == session_id, ChatSession.user_id == user_id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return session


def _provider_label(provider: str) -> str:
    labels = {
        "openai": "OpenAI",
        "openrouter": "OpenRouter",
        "gemini": "Gemini",
        "anthropic": "Anthropic",
        "cerebras": "Cerebras",
        "openai_compatible": "OpenAI-compatible",
    }
    return labels.get(provider, provider.title())


def _normalize_cloud_provider(provider: str) -> str:
    normalized = (provider or "").strip().lower()
    if normalized not in CLOUD_PROVIDERS:
        supported = ", ".join(sorted(CLOUD_PROVIDERS))
        raise HTTPException(status_code=400, detail=f"Unsupported cloud provider '{provider}'. Supported providers: {supported}.")
    return normalized


def _normalize_openai_compatible_base_url(base_url: str) -> str:
    raw_base_url = (base_url or "").strip()
    if not raw_base_url:
        raise HTTPException(status_code=400, detail="Base URL is required for OpenAI-compatible provider.")

    parsed = urlparse(raw_base_url if '://' in raw_base_url else f'https://{raw_base_url}')
    if not parsed.netloc and parsed.path:
        parsed = urlparse(f'https://{raw_base_url}')

    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Invalid OpenAI-compatible base URL.")

    scheme = parsed.scheme or 'https'
    port_suffix = f":{parsed.port}" if parsed.port is not None else ""
    path = parsed.path.rstrip('/')
    if path == '/':
        path = ''

    return f"{scheme}://{host}{port_suffix}{path}"


def _dedupe_model_ids(model_ids: list[str]) -> list[str]:
    deduped: list[str] = []
    for model_id in model_ids:
        normalized = (model_id or "").strip()
        if normalized and normalized not in deduped:
            deduped.append(normalized)
    return deduped


def _extract_provider_error_detail(response: httpx.Response, fallback: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        return fallback

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()

        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()

        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()

    return fallback


def _is_openai_chat_model(model_id: str) -> bool:
    lowered = (model_id or "").strip().lower()
    if not lowered:
        return False

    if any(marker in lowered for marker in ("embedding", "whisper", "tts", "dall-e", "moderation")):
        return False

    return lowered.startswith(("gpt-", "o1", "o3", "o4", "chatgpt"))


async def _fetch_openai_compatible_models(base_url: str, api_key: str, provider_name: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail=f"Could not reach {provider_name} API.")

    if response.status_code in (401, 403):
        detail = _extract_provider_error_detail(
            response,
            f"{provider_name} API key is invalid or does not have permission to list models.",
        )
        raise HTTPException(status_code=400, detail=detail)

    if response.status_code >= 400:
        detail = _extract_provider_error_detail(
            response,
            f"{provider_name} returned status {response.status_code} while listing models.",
        )
        raise HTTPException(status_code=502, detail=detail)

    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail=f"{provider_name} returned an invalid models response.")

    raw_models = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(raw_models, list):
        return []

    model_ids = [str(item.get("id") or "").strip() for item in raw_models if isinstance(item, dict)]
    return _dedupe_model_ids(model_ids)


async def _fetch_openai_models(api_key: str) -> list[str]:
    models = await _fetch_openai_compatible_models("https://api.openai.com/v1", api_key, "OpenAI")
    filtered = [model_id for model_id in models if _is_openai_chat_model(model_id)]
    return filtered or models


async def _fetch_cerebras_models(api_key: str) -> list[str]:
    return await _fetch_openai_compatible_models("https://api.cerebras.ai/v1", api_key, "Cerebras")


async def _fetch_openrouter_models(api_key: str) -> list[str]:
    return await _fetch_openai_compatible_models("https://openrouter.ai/api/v1", api_key, "OpenRouter")


async def _fetch_gemini_models(api_key: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key},
            )
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="Could not reach Gemini API.")

    if response.status_code in (400, 401, 403):
        detail = _extract_provider_error_detail(
            response,
            "Gemini API key is invalid or does not have permission to list models.",
        )
        raise HTTPException(status_code=400, detail=detail)

    if response.status_code >= 400:
        detail = _extract_provider_error_detail(
            response,
            f"Gemini returned status {response.status_code} while listing models.",
        )
        raise HTTPException(status_code=502, detail=detail)

    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Gemini returned an invalid models response.")

    raw_models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(raw_models, list):
        return []

    models: list[str] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue

        name = str(item.get("name") or "").strip()
        if not name:
            continue

        supported_methods: Any = item.get("supportedGenerationMethods")
        if isinstance(supported_methods, list) and supported_methods and "generateContent" not in supported_methods:
            continue

        normalized_name = name[7:] if name.startswith("models/") else name
        if normalized_name:
            models.append(normalized_name)

    return _dedupe_model_ids(models)


async def _fetch_anthropic_models(api_key: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(
                "https://api.anthropic.com/v1/models",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
            )
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="Could not reach Anthropic API.")

    if response.status_code in (401, 403):
        detail = _extract_provider_error_detail(
            response,
            "Anthropic API key is invalid or does not have permission to list models.",
        )
        raise HTTPException(status_code=400, detail=detail)

    if response.status_code >= 400:
        detail = _extract_provider_error_detail(
            response,
            f"Anthropic returned status {response.status_code} while listing models.",
        )
        raise HTTPException(status_code=502, detail=detail)

    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Anthropic returned an invalid models response.")

    raw_models = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(raw_models, list):
        return []

    model_ids = [str(item.get("id") or "").strip() for item in raw_models if isinstance(item, dict)]
    return _dedupe_model_ids(model_ids)


async def _fetch_cloud_models(provider: str, api_key: str, base_url: str | None = None) -> list[str]:
    if provider == "openai":
        return await _fetch_openai_models(api_key)
    if provider == "openrouter":
        return await _fetch_openrouter_models(api_key)
    if provider == "gemini":
        return await _fetch_gemini_models(api_key)
    if provider == "anthropic":
        return await _fetch_anthropic_models(api_key)
    if provider == "cerebras":
        return await _fetch_cerebras_models(api_key)
    if provider == "openai_compatible":
        if not base_url:
            raise HTTPException(status_code=400, detail="Base URL is required for OpenAI-compatible provider.")
        return await _fetch_openai_compatible_models(base_url, api_key, "OpenAI-compatible")
    return []

@router.post("/")
async def chat_endpoint(
    request: ChatRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Takes a query and document IDs, performs similarity search,
    and returns a streaming SSE response from the chosen LLM provider.
    """
    if not request.messages:
        raise HTTPException(status_code=400, detail="Messages list cannot be empty.")

    try:
        # We pass the generator to StreamingResponse
        # Media type text/event-stream is standard for Server-Sent Events (SSE)
        return StreamingResponse(
            generate_chat_stream(request),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions", response_model=list[ChatSessionResponse])
def list_chat_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return (
        db.query(ChatSession)
        .filter(ChatSession.user_id == current_user.id)
        .order_by(ChatSession.updated_at.desc())
        .all()
    )


@router.post("/sessions", response_model=ChatSessionResponse)
def create_chat_session(
    payload: ChatSessionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chat_session = ChatSession(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        title=payload.title or "New chat",
    )
    db.add(chat_session)
    db.commit()
    db.refresh(chat_session)
    return chat_session


@router.delete("/sessions")
def delete_all_chat_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    deleted_messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current_user.id)
        .delete(synchronize_session=False)
    )
    deleted_sessions = (
        db.query(ChatSession)
        .filter(ChatSession.user_id == current_user.id)
        .delete(synchronize_session=False)
    )

    db.commit()
    return {
        "ok": True,
        "deleted_sessions": deleted_sessions,
        "deleted_messages": deleted_messages,
    }


@router.delete("/sessions/{session_id}")
def delete_chat_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chat_session = _get_owned_session(db, session_id, current_user.id)
    db.delete(chat_session)
    db.commit()
    return {"ok": True}


@router.delete("/sessions/{session_id}/messages", response_model=ChatSessionResponse)
def clear_chat_session_messages(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chat_session = _get_owned_session(db, session_id, current_user.id)

    (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.user_id == current_user.id)
        .delete(synchronize_session=False)
    )

    chat_session.title = "New chat"
    chat_session.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(chat_session)
    return chat_session


@router.get("/sessions/{session_id}/messages", response_model=list[ChatMessageResponse])
def get_chat_messages(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_owned_session(db, session_id, current_user.id)
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id, ChatMessage.user_id == current_user.id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )


@router.post("/sessions/{session_id}/messages", response_model=ChatMessageResponse)
def create_chat_message(
    session_id: str,
    payload: ChatMessageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chat_session = _get_owned_session(db, session_id, current_user.id)

    message = ChatMessage(
        id=payload.id or str(uuid.uuid4()),
        session_id=chat_session.id,
        user_id=current_user.id,
        role=payload.role,
        text=payload.text,
        attached_files=payload.attached_files,
        citations=[citation.model_dump() for citation in payload.citations] if payload.citations else None,
        created_at=payload.created_at or datetime.utcnow(),
    )
    db.add(message)

    if (not chat_session.title or chat_session.title == "New chat") and payload.role == "user":
        trimmed = payload.text.strip()
        if trimmed:
            chat_session.title = trimmed[:80]
    chat_session.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(message)
    return message


@router.patch("/messages/{message_id}/feedback", response_model=ChatMessageResponse)
def update_message_feedback(
    message_id: str,
    payload: MessageFeedbackUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.feedback not in (None, "like", "dislike"):
        raise HTTPException(status_code=400, detail="Feedback must be 'like', 'dislike', or null")

    message = (
        db.query(ChatMessage)
        .join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .filter(ChatMessage.id == message_id, ChatSession.user_id == current_user.id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    message.feedback = payload.feedback
    db.commit()
    db.refresh(message)
    return message


@router.post("/cloud/validate", response_model=CloudProviderValidationResponse)
async def validate_cloud_provider(
    payload: CloudProviderValidationRequest,
    current_user: User = Depends(get_current_user),
):
    provider = _normalize_cloud_provider(payload.provider)
    api_key = (payload.api_key or "").strip()
    selected_model = (payload.selected_model or "").strip() or None
    base_url = _normalize_openai_compatible_base_url(payload.base_url or "") if provider == "openai_compatible" else None

    if len(api_key) < 20:
        raise HTTPException(status_code=400, detail="API key format looks invalid. It must be at least 20 characters.")

    available_models = await _fetch_cloud_models(provider, api_key, base_url=base_url)
    if not available_models:
        raise HTTPException(status_code=400, detail=f"No accessible {_provider_label(provider)} models were returned for this API key.")

    default_model = (get_default_cloud_model(provider) or "").strip()
    if default_model and default_model in available_models:
        resolved_model = default_model
    else:
        resolved_model = available_models[0]
        if not default_model:
            default_model = resolved_model

    selected_model_accessible = True
    fallback_applied = False
    if selected_model:
        selected_model_accessible = selected_model in available_models
        if selected_model_accessible:
            resolved_model = selected_model
        else:
            fallback_applied = True

    message = f"{_provider_label(provider)} API key is valid."
    if fallback_applied:
        message = (
            f"{_provider_label(provider)} API key is valid, but model '{selected_model}' is not accessible. "
            f"Falling back to '{resolved_model}'."
        )

    return CloudProviderValidationResponse(
        provider=provider,
        valid=True,
        message=message,
        available_models=available_models,
        default_model=default_model,
        selected_model=selected_model,
        selected_model_accessible=selected_model_accessible,
        resolved_model=resolved_model,
        fallback_applied=fallback_applied,
    )


def _build_local_llm_candidates(url: str) -> list[tuple[str, str]]:
    raw_url = (url or '').strip()
    if not raw_url:
        return []

    parsed = urlparse(raw_url if '://' in raw_url else f'http://{raw_url}')
    if not parsed.netloc and parsed.path:
        parsed = urlparse(f'http://{raw_url}')

    host = parsed.hostname
    if not host:
        return []

    scheme = parsed.scheme or 'http'
    suffix = parsed.path.rstrip('/')
    suffix = '' if suffix == '/' else suffix

    if 'ngrok' in host or scheme == 'https':
        port_candidates = [parsed.port] if parsed.port else [None]
    elif parsed.port is None:
        port_candidates = [1234, 11434]
    elif parsed.port in (1234, 11434):
        port_candidates = [parsed.port, 11434 if parsed.port == 1234 else 1234]
    else:
        port_candidates = [parsed.port]

    candidate_hosts = [host]
    fallback_hosts = {
        'host.docker.internal': ['localhost', '127.0.0.1'],
        'localhost': ['127.0.0.1', 'host.docker.internal'],
        '127.0.0.1': ['localhost', 'host.docker.internal'],
        'ollama': ['host.docker.internal', 'localhost', '127.0.0.1'],
        'lmstudio': ['host.docker.internal', 'localhost', '127.0.0.1'],
    }
    for fallback_host in fallback_hosts.get(host, []):
        if fallback_host not in candidate_hosts:
            candidate_hosts.append(fallback_host)

    if host in ('localhost', '127.0.0.1', 'host.docker.internal'):
        for service_host in ('ollama', 'lmstudio'):
            if service_host not in candidate_hosts:
                candidate_hosts.append(service_host)

    return [
        (
            f'{scheme}://{candidate_host}:{port}' if port is not None else f'{scheme}://{candidate_host}',
            f'{scheme}://{candidate_host}:{port}{suffix}' if port is not None else f'{scheme}://{candidate_host}{suffix}'
        )
        for candidate_host in candidate_hosts
        for port in port_candidates
    ]


def _build_probe_paths(url: str) -> list[str]:
    raw_url = (url or '').lower()
    if '/api/generate' in raw_url or '/api/' in raw_url:
        return ['/api/tags', '/']
    return ['/v1/models', '/models', '/api/tags', '/']


def _default_local_llm_candidates() -> list[tuple[str, str]]:
    return [
        ('http://localhost:11434', 'http://localhost:11434'),
        ('http://localhost:1234', 'http://localhost:1234'),
        ('http://127.0.0.1:11434', 'http://127.0.0.1:11434'),
        ('http://127.0.0.1:1234', 'http://127.0.0.1:1234'),
        ('http://host.docker.internal:11434', 'http://host.docker.internal:11434'),
        ('http://host.docker.internal:1234', 'http://host.docker.internal:1234'),
        ('http://ollama:11434', 'http://ollama:11434'),
        ('http://lmstudio:1234', 'http://lmstudio:1234'),
    ]


def _dedupe_local_candidates(candidates: list[tuple[str, str]]) -> list[tuple[str, str]]:
    deduped: list[tuple[str, str]] = []
    seen = set()
    for base_url, resolved_url in candidates:
        key = (base_url.rstrip('/'), resolved_url.rstrip('/'))
        if key in seen:
            continue
        seen.add(key)
        deduped.append((base_url.rstrip('/'), resolved_url.rstrip('/')))
    return deduped


def _extract_ollama_model_names(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []
    models = payload.get('models')
    if not isinstance(models, list):
        return []

    model_names: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or item.get('model') or '').strip()
        if name and name not in model_names:
            model_names.append(name)
    return model_names


def _looks_like_ollama_tags_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False

    models = payload.get('models')
    if not isinstance(models, list):
        return False

    if not models:
        return True

    return any(
        isinstance(item, dict) and str(item.get('name') or item.get('model') or '').strip()
        for item in models
    )


def _extract_openai_compatible_model_ids(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []
    data = payload.get('data')
    if not isinstance(data, list):
        return []

    model_ids: list[str] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get('id') or '').strip()
        if model_id and model_id not in model_ids:
            model_ids.append(model_id)
    return model_ids


def _infer_openai_compatible_runtime(base_url: str) -> str:
    parsed = urlparse(base_url)
    host = (parsed.hostname or '').lower()
    if parsed.port == 1234 or 'lmstudio' in host:
        return 'lm_studio'
    return 'openai_compatible'


def _docker_hint_for_endpoint(endpoint: str) -> Optional[str]:
    host = (urlparse(endpoint).hostname or '').lower()
    if host in ('localhost', '127.0.0.1'):
        return "If backend runs in Docker, use host.docker.internal instead of localhost."
    if host == 'host.docker.internal':
        return "Using host.docker.internal (recommended when backend is containerized and runtime runs on host)."
    if host in ('ollama', 'lmstudio'):
        return "Using Docker service DNS host. Ensure backend and runtime containers share the same docker-compose network."
    return None


def _normalize_requested_local_base(url: str) -> str:
    raw_url = (url or '').strip()
    if not raw_url:
        return ''

    parsed = urlparse(raw_url if '://' in raw_url else f'http://{raw_url}')
    if not parsed.netloc and parsed.path:
        parsed = urlparse(f'http://{raw_url}')

    host = parsed.hostname
    if not host:
        return ''

    scheme = parsed.scheme or 'http'
    if parsed.port is not None:
        return f'{scheme}://{host}:{parsed.port}'
    return f'{scheme}://{host}'


async def _discover_local_runtime(url: str) -> LocalLLMDiscoveryResponse:
    requested_url = (url or '').strip()
    requested_base = _normalize_requested_local_base(requested_url)

    candidate_pairs = _build_local_llm_candidates(requested_url) if requested_url else _default_local_llm_candidates()
    candidates = _dedupe_local_candidates(candidate_pairs)
    if not candidates:
        raise HTTPException(status_code=400, detail="Local LLM URL is required")

    attempts: list[str] = []

    async with httpx.AsyncClient(timeout=3.5) as client:
        for base_url, resolved_url in candidates:
            fallback_applied = bool(requested_base and requested_base.rstrip('/') != base_url.rstrip('/'))

            ollama_target = f"{base_url}/api/tags"
            try:
                ollama_response = await client.get(ollama_target, follow_redirects=True)
                attempts.append(f"{ollama_target} -> {ollama_response.status_code}")
                if ollama_response.status_code == 200:
                    try:
                        ollama_payload = ollama_response.json()
                    except ValueError:
                        ollama_payload = {}

                    if not _looks_like_ollama_tags_payload(ollama_payload):
                        attempts.append(f"{ollama_target} -> 200 (non-Ollama payload)")
                    else:
                        model_names = _extract_ollama_model_names(ollama_payload)
                        detected_model = model_names[0] if model_names else None
                        message = "Detected Ollama runtime."
                        if not model_names:
                            message = "Detected Ollama runtime but no local models were found. Pull a model with 'ollama pull <model>'."

                        return LocalLLMDiscoveryResponse(
                            endpoint=base_url,
                            endpoint_type='ollama',
                            available=True,
                            detected_model=detected_model,
                            available_models=model_names,
                            message=message,
                            docker_hint=_docker_hint_for_endpoint(base_url),
                            fallback_applied=fallback_applied,
                            probe_url=ollama_target,
                        )
            except httpx.RequestError as exc:
                attempts.append(f"{ollama_target} -> {exc.__class__.__name__}: {exc}")

            for openai_path in ('/v1/models', '/api/v1/models', '/models'):
                target = f"{base_url}{openai_path}"
                try:
                    response = await client.get(target, follow_redirects=True)
                    attempts.append(f"{target} -> {response.status_code}")
                    if response.status_code != 200:
                        continue

                    try:
                        payload = response.json()
                    except ValueError:
                        payload = {}

                    model_ids = _extract_openai_compatible_model_ids(payload)
                    endpoint_type = _infer_openai_compatible_runtime(base_url)
                    endpoint_for_chat = f"{base_url}/v1" if openai_path in ('/v1/models', '/api/v1/models') else base_url
                    endpoint_for_chat = endpoint_for_chat.rstrip('/')

                    message = (
                        "Detected LM Studio (OpenAI-compatible) runtime."
                        if endpoint_type == 'lm_studio'
                        else "Detected OpenAI-compatible local runtime."
                    )
                    if openai_path == '/api/v1/models':
                        message = f"{message} Normalized endpoint to /v1 for OpenAI-compatible chat completions."
                    if not model_ids:
                        message = f"{message} The runtime responded, but no models were returned."

                    detected_model = model_ids[0] if model_ids else None
                    return LocalLLMDiscoveryResponse(
                        endpoint=endpoint_for_chat,
                        endpoint_type=endpoint_type,
                        available=True,
                        detected_model=detected_model,
                        available_models=model_ids,
                        message=message,
                        docker_hint=_docker_hint_for_endpoint(base_url),
                        fallback_applied=fallback_applied,
                        probe_url=target,
                    )
                except httpx.RequestError as exc:
                    attempts.append(f"{target} -> {exc.__class__.__name__}: {exc}")

    attempted = '; '.join(attempts[:10])
    detail = "Could not auto-detect a local runtime. Start Ollama (11434) or LM Studio/OpenAI-compatible server (1234)."
    if attempted:
        detail = f"{detail} Attempts: {attempted}"
    raise HTTPException(status_code=502, detail=detail)


@router.get("/local/discover", response_model=LocalLLMDiscoveryResponse)
async def discover_local_runtime(
    url: str = "",
    current_user: User = Depends(get_current_user),
):
    return await _discover_local_runtime(url)

@router.get("/health")
async def check_health(
    url: str = "",
    current_user: User = Depends(get_current_user),
):
    """
    Proxies a health check to a local LLM server to avoid browser CORS issues.
    """
    discovery = await _discover_local_runtime(url)
    return {
        "status": "ok",
        "url": discovery.probe_url or discovery.endpoint,
        "resolved_url": discovery.endpoint,
        "endpoint_type": discovery.endpoint_type,
        "detected_model": discovery.detected_model,
        "available_models": discovery.available_models,
        "message": discovery.message,
        "docker_hint": discovery.docker_hint,
        "fallback_applied": discovery.fallback_applied,
    }
