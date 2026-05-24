FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

COPY requirements.txt .

RUN apt-get update \
    && apt-get install -y gcc libpq-dev \
    && pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Pre-download the ChromaDB ONNX embedding model (all-MiniLM-L6-v2, ~79 MB)
# so it is baked into the image and never downloaded at runtime.
RUN python -c "from chromadb.utils import embedding_functions; embedding_functions.DefaultEmbeddingFunction()"

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
