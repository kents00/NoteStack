from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime
from typing import Any

CloudApiProvider = Literal["gemini", "openai", "anthropic", "cerebras", "openrouter", "openai_compatible"]

class Message(BaseModel):
    role: str # 'user' or 'model'/'assistant'
    text: str


class CitationItem(BaseModel):
    citation_number: int
    document_id: str
    document_name: str
    snippet: str
    chunk_index: int
    chunk_indices: Optional[List[int]] = None
    source_label: Optional[str] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    document_ids: List[str]
    api_provider: str = "gemini" # 'gemini', 'openai', 'openrouter', 'anthropic', 'cerebras', 'openai_compatible', 'local'
    api_key: Optional[str] = None
    cloud_model: Optional[str] = None
    cloud_base_url: Optional[str] = None
    local_model_url: Optional[str] = None
    local_model_name: Optional[str] = None
    system_instructions: Optional[str] = None


class CloudProviderValidationRequest(BaseModel):
    provider: str
    api_key: str
    selected_model: Optional[str] = None
    base_url: Optional[str] = None


class CloudProviderValidationResponse(BaseModel):
    provider: CloudApiProvider
    valid: bool
    message: str
    available_models: List[str] = Field(default_factory=list)
    default_model: Optional[str] = None
    selected_model: Optional[str] = None
    selected_model_accessible: bool = False
    resolved_model: Optional[str] = None
    fallback_applied: bool = False


LocalEndpointType = Literal["ollama", "lm_studio", "openai_compatible"]


class LocalLLMDiscoveryResponse(BaseModel):
    status: str = "ok"
    endpoint: str
    endpoint_type: LocalEndpointType
    available: bool = True
    detected_model: Optional[str] = None
    available_models: List[str] = Field(default_factory=list)
    message: str
    docker_hint: Optional[str] = None
    fallback_applied: bool = False
    probe_url: Optional[str] = None


class ChatSessionCreate(BaseModel):
    title: Optional[str] = None


class ChatSessionResponse(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ChatMessageCreate(BaseModel):
    id: Optional[str] = None
    role: str
    text: str
    attached_files: Optional[List[Any]] = None
    citations: Optional[List[CitationItem]] = None
    created_at: Optional[datetime] = None


class ChatMessageResponse(BaseModel):
    id: str
    session_id: str
    role: str
    text: str
    attached_files: Optional[List[Any]] = None
    citations: Optional[List[CitationItem]] = None
    feedback: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MessageFeedbackUpdate(BaseModel):
    feedback: Optional[str] = None  # 'like' | 'dislike' | None
