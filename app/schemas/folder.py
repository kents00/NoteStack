from pydantic import BaseModel
from datetime import datetime
from uuid import UUID


class FolderCreate(BaseModel):
    name: str


class FolderUpdate(BaseModel):
    name: str


class FolderResponse(BaseModel):
    id: UUID
    user_id: UUID
    name: str
    created_at: datetime

    class Config:
        from_attributes = True
