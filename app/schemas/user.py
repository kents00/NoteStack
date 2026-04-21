from pydantic import BaseModel, EmailStr, Field
from typing import Optional
import uuid

class UserBase(BaseModel):
    email: EmailStr
    first_name: Optional[str] = None
    last_name: Optional[str] = None

class UserCreate(UserBase):
    password: str


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=8)

class UserInDBBase(UserBase):
    id: uuid.UUID
    is_active: bool

    class Config:
        from_attributes = True

class User(UserInDBBase):
    pass
