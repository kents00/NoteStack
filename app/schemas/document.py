from pydantic import BaseModel
from typing import Optional
from uuid import UUID
from datetime import datetime

class DocumentBase(BaseModel):
    name: str
    folder_id: Optional[UUID] = None

class DocumentCreate(DocumentBase):
    pass


class DocumentUpdate(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[UUID] = None

class DocumentResponse(DocumentBase):
    id: UUID
    user_id: UUID
    mime_type: str
    size: Optional[int]
    status: str
    created_at: datetime

    class Config:
        from_attributes = True
