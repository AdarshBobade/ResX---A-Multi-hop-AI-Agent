export type TrailStep = Record<string, unknown>

export type Conversation = {
  question: string
  answer: string
}

export type Citation = {
  id: string
  source_type: string
  source: string
  title: string | null
  url: string | null
  page: number | null
  doc_id: string | null
  chunk_id: string | null
  published_date: string | null
  content: string | null
}

export type GroundednessCheck = {
  score: number
  verdict: string
  unsupported_claims: string[]
  reasoning: string
}

export type AskResponse = {
  answer: string
  trail: TrailStep[]
  confidence: number
  citations: Citation[]
  groundedness: GroundednessCheck
  retrieval_calls: number
  web_search_calls: number
  llm_calls: number
  document_evidence_count?: number
  web_evidence_count?: number
  research_mode?: {
    web_search: boolean
    deep_research: boolean
  }
}

export type UploadResponse = {
  message: string
  doc_id: string
  filename: string
  chunks: number
  pages: number
  path: string
}

export type UploadJobResponse = {
  job_id: string
  status: string
}

export type IngestionStatus = {
  status: 'processing' | 'ready' | 'failed'
  doc_id?: string
  filename?: string
  chunks?: number
  pages?: number
  already_exists?: boolean
  path?: string
  error?: string
  current_page?: number
  total_pages?: number
}

export type Document = {
  doc_id: string
  filename: string
  file_hash?: string | null
  chunks?: number
  pages?: number
  path?: string
}

export type AskError = {
  detail: string
}