from pydantic import BaseModel
from typing import Optional


class NoteBase(BaseModel):
    title: str
    content: str
    timestamp: int


class NoteCreate(NoteBase):
    id: Optional[str] = None


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    timestamp: Optional[int] = None


class NoteResponse(NoteBase):
    id: str

    class Config:
        from_attributes = True
