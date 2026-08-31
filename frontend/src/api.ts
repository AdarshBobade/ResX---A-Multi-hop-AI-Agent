import type { AskResponse, Conversation, Document, UploadJobResponse, IngestionStatus } from './types'

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

async function readError(response: Response): Promise<string> {
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return 'Connecting to backend... please wait a moment.'
  }

  let detail = `Request failed (${response.status})`
  try {
    const data = (await response.json()) as { detail?: string }
    if (data.detail) detail = data.detail
  } catch {
    // ignore JSON parse errors
  }
  return detail
}

export async function askQuestion(
  query: string,
  history: Conversation[],
  options: { webSearch: boolean; deepResearch: boolean },
): Promise<AskResponse> {
  const response = await fetch(`${API_BASE_URL}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      history,
      web_search: options.webSearch,
      deep_research: options.deepResearch,
    }),
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  const data = await response.json();

  if (!('sources' in data) && Array.isArray((data as any).citations)) {
    (data as any).sources = (data as any).citations.map((c: any) => c.source ?? c.title ?? c.url ?? c.doc_id ?? JSON.stringify(c));
  }

  return data as AskResponse
}

export async function uploadPdf(file: File): Promise<UploadJobResponse> {
  const body = new FormData()
  body.append('file', file)

  const response = await fetch(`${API_BASE_URL}/upload`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  return response.json() as Promise<UploadJobResponse>
}

export async function pollUploadStatus(
  jobId: string,
  onUpdate?: (status: IngestionStatus) => void,
): Promise<IngestionStatus> {
  const maxAttempts = 300
  const intervalMs = 2000

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${API_BASE_URL}/upload/${encodeURIComponent(jobId)}/status`)
    if (!response.ok) throw new Error(await readError(response))

    const data = (await response.json()) as IngestionStatus
    onUpdate?.(data)

    if (data.status === 'ready') return data
    if (data.status === 'failed') throw new Error(data.error ?? 'Ingestion failed')

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error('Ingestion timed out — check backend logs')
}

export async function listDocuments(): Promise<Document[]> {
  const response = await fetch(`${API_BASE_URL}/documents`)
  if (!response.ok) throw new Error(await readError(response))
  const data = (await response.json()) as { documents?: Document[] }
  return Array.isArray(data.documents) ? data.documents : []
}

export async function deleteDocument(docId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readError(response))
}