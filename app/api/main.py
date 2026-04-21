from fastapi import APIRouter
from app.api.routes import auth, users, documents, chat, notes, folders

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(documents.router, prefix="/documents", tags=["documents"])
api_router.include_router(chat.router, prefix="/chat", tags=["chat"])
api_router.include_router(notes.router, prefix="/notes", tags=["notes"])
api_router.include_router(folders.router, prefix="/folders", tags=["folders"])
