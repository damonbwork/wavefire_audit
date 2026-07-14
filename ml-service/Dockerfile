FROM python:3.11-slim

WORKDIR /app

# System deps for scikit-learn / numpy wheels are already covered by manylinux
# wheels on this base image — no build-essential needed, keeps the image small.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Railway sets $PORT at runtime; default to 8000 for local/dev use.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
