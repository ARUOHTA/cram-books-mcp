FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Minimal runtime deps for MCP server
RUN pip install --no-cache-dir "mcp[cli]" httpx

COPY server.py /app/server.py

CMD ["python","-u","/app/server.py"]
