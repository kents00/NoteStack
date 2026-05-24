import os
import chromadb
from chromadb.utils import embedding_functions
from sqlalchemy.orm import Session
from app.db.database import SessionLocal
from app.models.document import Document, DocumentStatus
from app.services.extractor import extract_text
from langchain_text_splitters import RecursiveCharacterTextSplitter

CHROMA_PERSIST_DIR = "chroma_data"

# Use ChromaDB's built-in ONNX embedding function (all-MiniLM-L6-v2 via onnxruntime).
# Initialized lazily inside process_document_background to avoid downloading the model
# at container startup — the 79 MB ONNX download only happens when a document is processed.


def process_document_background(document_id: str, file_path: str, mime_type: str):
    """Background task to extract, chunk, and embed a document."""
    db = SessionLocal()
    document = db.query(Document).filter(Document.id == document_id).first()

    if not document:
        db.close()
        return

    try:
        # Update status
        document.status = DocumentStatus.PROCESSING
        db.commit()

        # 1. Extract text
        text = extract_text(file_path, mime_type)
        if not text.strip():
            raise ValueError("No text could be extracted from the document.")

        # 2. Chunk text
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=100,
        )
        chunks = text_splitter.split_text(text)

        # 3. Build metadata for each chunk
        metadatas = [
            {
                "document_id": str(document.id),
                "name": document.name,
                "chunk_index": index,
                "chunk_id": f"{document.id}:{index}",
            }
            for index, _ in enumerate(chunks)
        ]

        # 4. Embed and store via ChromaDB native client (ONNX — no PyTorch)
        # Lazy-init here so the model is only loaded when actually needed.
        _embed_fn = embedding_functions.DefaultEmbeddingFunction()
        client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
        collection = client.get_or_create_collection(
            name="notestack_docs",
            embedding_function=_embed_fn,
        )
        ids = [f"{document.id}:{i}" for i in range(len(chunks))]
        collection.add(documents=chunks, metadatas=metadatas, ids=ids)

        # 5. Mark as processed
        document.status = DocumentStatus.PROCESSED
        db.commit()

    except Exception as e:
        print(f"Error processing document {document_id}: {e}")
        document.status = DocumentStatus.ERROR
        db.commit()
    finally:
        db.close()
