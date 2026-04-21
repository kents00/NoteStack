from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from app.core.config import settings

engine = create_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def ensure_schema_compat() -> None:
    """Apply lightweight schema updates for existing databases without Alembic."""
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())

    with engine.begin() as connection:
        if "chat_messages" in table_names:
            chat_columns = {column["name"] for column in inspector.get_columns("chat_messages")}
            if "citations" not in chat_columns:
                connection.execute(text("ALTER TABLE chat_messages ADD COLUMN citations JSON"))

        if "documents" in table_names:
            document_columns = {column["name"] for column in inspector.get_columns("documents")}
            if "size" not in document_columns:
                connection.execute(text("ALTER TABLE documents ADD COLUMN size INTEGER"))
            if "created_at" not in document_columns:
                connection.execute(text("ALTER TABLE documents ADD COLUMN created_at TIMESTAMP"))
                connection.execute(text("UPDATE documents SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"))
                connection.execute(text("ALTER TABLE documents ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP"))
                connection.execute(text("ALTER TABLE documents ALTER COLUMN created_at SET NOT NULL"))

        if "folders" in table_names:
            folder_columns = {column["name"] for column in inspector.get_columns("folders")}
            if "created_at" not in folder_columns:
                connection.execute(text("ALTER TABLE folders ADD COLUMN created_at TIMESTAMP"))
                connection.execute(text("UPDATE folders SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"))
                connection.execute(text("ALTER TABLE folders ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP"))
                connection.execute(text("ALTER TABLE folders ALTER COLUMN created_at SET NOT NULL"))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
