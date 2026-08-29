import os
import uuid
import hashlib
from pathlib import Path
import gc
import chromadb
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from pypdf import PdfReader

# File config
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB max capacity of the pdf

BATCH_SIZE = 8

# Chroma
CHROMA_PATH = os.getenv("CHROMA_PATH", "./chroma_db")
client = chromadb.PersistentClient(path=CHROMA_PATH)
embed_fn = SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2"
)

collection = client.get_or_create_collection("docs", embedding_function=embed_fn)


def reset_session_database() -> None:
    """
    Clear all indexed documents and uploaded PDFs for a fresh application session.

    This is called once when the FastAPI application starts, not on every upload.
    """

    # Clear documents from the EXISTING collection.
    existing_ids = collection.get()["ids"]

    if existing_ids:
        collection.delete(ids=existing_ids)

    from app_data.retrieval import invalidate_bm25_cache
    invalidate_bm25_cache()

    upload_root = UPLOAD_DIR.resolve()

    for upload_file in upload_root.iterdir():
        if upload_file.is_file():
            try:
                upload_file.unlink()
            except OSError:
                pass


# Chunking
def chunk_text(text, chunk_size=300):
    words = text.split()
    overlap = 75  # Overlapping Chunking
    return [
        " ".join(words[i : i + chunk_size])
        for i in range(0, len(words), chunk_size - overlap)
    ]

# File hash
def calculate_file_hash(content: bytes) -> str:
    """
    SHA256 hash used to detect duplicate uploads.
    """
    return hashlib.sha256(content).hexdigest()


# Ingest PDF
def ingest_pdf(path: str | Path,
               file_hash: str | None = None,
               original_filename: str | None = None,
               progress_callback=None) -> dict:

    path = Path(path)
    reader = PdfReader(str(path))

    doc_id = uuid.uuid4().hex
    filename = original_filename or path.name
    total_pages = len(reader.pages)

    chunk_index = 0
    total_chunks = 0

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if not text.strip():
            if progress_callback:
                progress_callback(page_number, total_pages)
            continue

        chunks = chunk_text(text)
        if not chunks:
            if progress_callback:
                progress_callback(page_number, total_pages)
            continue

        page_ids = [f"{doc_id}-{chunk_index + i}" for i in range(len(chunks))]
        page_metadatas = [{
            "doc_id": doc_id,
            "source": filename,
            "page": page_number,
            "chunk_index": chunk_index + i,
            "file_hash": file_hash or ""
        } for i in range(len(chunks))]

    
        collection.add(documents=chunks, ids=page_ids, metadatas=page_metadatas)
        gc.collect()

        chunk_index += len(chunks)
        total_chunks += len(chunks)

        if progress_callback:
            progress_callback(page_number, total_pages)

    if total_chunks == 0:
        raise ValueError("No extractable text found in the PDF.")

    from app_data.retrieval import invalidate_bm25_cache
    invalidate_bm25_cache()

    return {
        "doc_id": doc_id,
        "filename": path.name,
        "chunks": total_chunks,
        "pages": total_pages
    }


# Save upload
def save_upload(filename: str, content: bytes) -> Path:
    if not filename:
        raise ValueError("Filename is required.")

    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise ValueError("Only PDF files are supported.")

    if not content:
        raise ValueError("Uploaded file is empty.")

    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError(f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.")

    safe_stem = Path(filename).stem.replace(" ", "_")[:80] or "document"
    dest = UPLOAD_DIR / f"{safe_stem}_{uuid.uuid4().hex[:8]}{suffix}"
    dest.write_bytes(content)
    return dest

# Delete documnets
def delete_document(doc_id: str) -> int:
    """
    Delete every chunk belonging to a document.
    Returns number of deleted chunks.
    """
    results = collection.get(where={"doc_id": doc_id})

    ids = results["ids"]

    if not ids:
        return 0

    from app_data.retrieval import invalidate_bm25_cache
    invalidate_bm25_cache()

    collection.delete(ids=ids)

    # Chroma stores the generated upload filename in the source metadata.
    # Remove the corresponding PDF as well, while keeping the operation
    # constrained to the configured upload directory.
    for metadata in results.get("metadatas") or []:
        source = metadata.get("source") if metadata else None
        if source:
            upload_path = (UPLOAD_DIR / Path(source).name).resolve()
            upload_root = UPLOAD_DIR.resolve()
            if upload_path.parent == upload_root and upload_path.is_file():
                try:
                    upload_path.unlink()
                except OSError:
                    # The index deletion is still authoritative if the file
                    # has already been removed or cannot be deleted.
                    pass
            break

    return len(ids)


# List Documents
def list_documents() -> list[dict]:
    """
    Return unique documents currently stored in Chroma.
    """
    results = collection.get(include=["metadatas"])
    documents = {}

    for metadata in results["metadatas"]:
        doc_id = metadata.get("doc_id")
        if not doc_id:
            continue

        if doc_id not in documents:

            documents[doc_id] = {
                                    "doc_id": doc_id,
                                    "filename": metadata.get("source",
                                                            "unknown"
                                                            ),
                                    "file_hash": metadata.get("file_hash"),
                                    "chunks": 0,
                }

        documents[doc_id]["chunks"] += 1

    return list(documents.values())



def ingest_upload(filename: str, content: bytes, progress_callback=None) -> dict:
    file_hash = calculate_file_hash(content)

    # 1. Check if EXACT same file already exists
    existing_hash = collection.get(where={
                                            "file_hash": file_hash
                                        },
                                    include=["metadatas"])

    if existing_hash["ids"]:

        metadata = existing_hash["metadatas"][0]

        return {
            "doc_id": metadata["doc_id"],
            "filename": metadata.get(
                "source",
                filename
            ),
            "chunks": len(
                existing_hash["ids"]
            ),
            "already_exists": True,
        }

    existing_filename = collection.get(
        where={
            "source": filename
        },
        include=["metadatas"],
    )

    old_doc_ids = {
        metadata.get("doc_id")
        for metadata in existing_filename["metadatas"]
        if metadata.get("doc_id")
    }

    for old_doc_id in old_doc_ids:

        if old_doc_id:
            delete_document(old_doc_id)


    path = save_upload(filename, content)
    result = ingest_pdf(path=path,
                        file_hash=file_hash,
                        original_filename=filename,
                        progress_callback=progress_callback)

    result["path"] = str(path)
    result["already_exists"] = False

    return result




if __name__ == "__main__":
    print("Documents currently stored:")

    for document in list_documents():
        print(document)

    print("Ingested !")
