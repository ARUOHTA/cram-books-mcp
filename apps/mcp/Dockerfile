FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Minimal runtime deps for MCP server
RUN pip install --no-cache-dir "mcp[cli]" httpx uvicorn fastmcp

COPY . /app/

CMD ["python","-u","/app/server.py"]
