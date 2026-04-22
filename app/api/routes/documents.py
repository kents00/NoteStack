import os
import base64
from fastapi import APIRouter, Depends, UploadFile, File, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session
from typing import List
import uuid

from app.db.database import get_db
from app.core.storage import save_upload_file, get_file_path
from app.api.deps import get_current_user
from app.models.user import User
from app.models.document import Document
from app.schemas.document import DocumentResponse, DocumentUpdate
from app.services.ingestion import process_document_background

router = APIRouter()

@router.post("/upload", response_model=DocumentResponse)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    folder_id: str = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Upload a document, save it locally, and start background processing.
    """
    file_id = str(uuid.uuid4())
    extension = os.path.splitext(file.filename)[1]
    saved_filename = f"{file_id}{extension}"

    # Save to local volume
    file_path = await save_upload_file(file, saved_filename)
    file_size = os.path.getsize(file_path) if os.path.exists(file_path) else None

    # Create DB entry
    document = Document(
        id=file_id,
        user_id=current_user.id,
        folder_id=folder_id if folder_id else None,
        name=file.filename,
        mime_type=file.content_type,
        size=file_size,
        s3_key=saved_filename,
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    # Dispatch background task for text extraction and vector DB insertion
    background_tasks.add_task(
        process_document_background,
        document_id=document.id,
        file_path=file_path,
        mime_type=document.mime_type
    )

    return document

@router.get("/", response_model=List[DocumentResponse])
def get_documents(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get all documents for the current user."""
    documents = db.query(Document).filter(Document.user_id == current_user.id).all()

    should_commit = False
    for document in documents:
        if document.size is None and document.s3_key:
            file_path = get_file_path(document.s3_key)
            if os.path.exists(file_path):
                document.size = os.path.getsize(file_path)
                should_commit = True

    if should_commit:
        db.commit()

    return documents


@router.put("/{document_id}", response_model=DocumentResponse)
def update_document(
    document_id: str,
    payload: DocumentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    document = (
        db.query(Document)
        .filter(Document.id == document_id, Document.user_id == current_user.id)
        .first()
    )
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        document.name = update_data["name"]
    # folder_id is nullable, so explicit null means "remove from folder"
    if "folder_id" in update_data:
        document.folder_id = update_data["folder_id"]

    db.commit()
    db.refresh(document)
    return document


@router.delete("/{document_id}")
def delete_document(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    document = (
        db.query(Document)
        .filter(Document.id == document_id, Document.user_id == current_user.id)
        .first()
    )
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    db.delete(document)
    db.commit()
    return {"ok": True}


@router.get("/{document_id}/content")
def get_document_content(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    document = (
        db.query(Document)
        .filter(Document.id == document_id, Document.user_id == current_user.id)
        .first()
    )
    if not document:
        raise HTTPException(status_code=404, detail="Document record not found in database")

    file_path = get_file_path(document.s3_key)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Document file not found on disk storage")

    with open(file_path, "rb") as f:
        content = f.read()

    return {"content": base64.b64encode(content).decode("utf-8")}
