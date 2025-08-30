FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app

RUN pip install --no-cache-dir "mcp[cli]" httpx
COPY server.py /app/server.py

# 依存はそのままでOK（mcp[cli] を入れていれば uvicorn も入っています）
CMD ["python","-u","/app/server.py"]
