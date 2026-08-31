FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    VECLIB_MAXIMUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copying the dependencies first ->
COPY requirements.txt .

RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app_data ./app_data

RUN mkdir -p /app/data/uploads \
    && mkdir -p /app/chroma_db

# Render provides PORT at runtime.
ENV PORT=10000

# Document the port used by the application.
EXPOSE 10000

# Start FastAPI
CMD ["sh", "-c", "uvicorn app_data.main:app --host 0.0.0.0 --port ${PORT:-10000}"]