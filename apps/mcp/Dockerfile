FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
ENV SENTENCE_TRANSFORMERS_HOME=/app/models
WORKDIR /app

# Base dependencies for MCP + HTTP client + semantic search (CPU only)
# 1) Install MCP + httpx + numpy
# 2) Install CPU-only torch to avoid pulling massive CUDA layers
# 3) Install sentence-transformers (will use the already-installed torch)
RUN pip install --no-cache-dir "mcp[cli]" httpx numpy \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.3.1 \
    && pip install --no-cache-dir "sentence-transformers==2.7.0"

# Note: モデルの事前ダウンロードはビルド時間が延びるため省略。
# 初回リクエスト時に自動ダウンロードされます（最小インスタンス>0推奨）。

COPY server.py /app/server.py

CMD ["python","-u","/app/server.py"]
