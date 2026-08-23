import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { askQuestion, deleteDocument, uploadPdf, pollUploadStatus } from './api'
import type { AskResponse, Conversation, Document } from './types'
import './App.css'

const EXAMPLES = [
  'How did the invention of the printing press influence the Scientific Revolution?',
  'What connects the fall of Constantinople to the Age of Exploration?',
  'How do coral reefs affect coastal economies during climate change?',
]

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const RESEARCH_STAGES = [
  { label: 'Planning', detail: 'Breaking the question into research hops' },
  { label: 'Retrieving', detail: 'Searching the available sources' },
  { label: 'Chunking', detail: 'Collecting relevant evidence chunks' },
  { label: 'Reranking', detail: 'Scoring evidence by relevance' },
  { label: 'Reflecting', detail: 'Checking whether more evidence is needed' },
  { label: 'Synthesizing', detail: 'Writing a cited answer from the evidence' },
] as const

type ProgressState = 'idle' | 'working' | 'complete' | 'error'

function parseTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  return cells.length >= 2 ? cells : null
}

function isTableSeparator(line: string) {
  const cells = parseTableRow(line)
  return Boolean(cells && cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
}

function MarkdownTableCell({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{content}</ReactMarkdown>
}

function MarkdownTable({ rows }: { rows: string[][] }) {
  const header = rows[0] ?? []
  return (
    <div className="markdown-table-wrap">
      <table className="markdown-table">
        <thead>
          <tr>{header.map((cell, index) => <th key={index}><MarkdownTableCell content={cell} /></th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(2).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((_, columnIndex) => (
                <td key={columnIndex}>
                  <MarkdownTableCell content={row[columnIndex] ?? ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MarkdownContent({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let markdownLines: string[] = []
  let index = 0

  const flushMarkdown = () => {
    if (markdownLines.length > 0) {
            blocks.push(
                        <ReactMarkdown key={`markdown-${blocks.length}`} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                          {markdownLines.join('\n')}
                        </ReactMarkdown>
                      )
      markdownLines = []
    }
  }

  while (index < lines.length) {
    const header = parseTableRow(lines[index])
    if (header && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const rows = [header, parseTableRow(lines[index + 1]) as string[]]
      index += 2
      while (index < lines.length) {
        const row = parseTableRow(lines[index])
        if (!row) break
        rows.push(row)
        index += 1
      }
      flushMarkdown()
      blocks.push(<MarkdownTable key={`table-${blocks.length}`} rows={rows} />)
      continue
    }
    markdownLines.push(lines[index])
    index += 1
  }

  flushMarkdown()
  return <>{blocks}</>
}

function useTypewriter(text: string, charactersPerSecond = 90) {
  const [visibleLength, setVisibleLength] = useState(0)

  useEffect(() => {
    setVisibleLength(0)
    if (!text) return

    let index = 0
    const interval = window.setInterval(() => {
      index = Math.min(index + 1, text.length)
      setVisibleLength(index)
      if (index === text.length) window.clearInterval(interval)
    }, 1000 / charactersPerSecond)

    return () => window.clearInterval(interval)
  }, [text, charactersPerSecond])

  return {
    text: text.slice(0, visibleLength),
    isTyping: visibleLength < text.length,
  }
}

function formatLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function estimateUploadProgress(elapsedMs: number, fileSizeBytes: number): number {
  const sizeMb = fileSizeBytes / (1024 * 1024)
  // Bigger files get a longer estimated duration — roughly 20s per MB,
  // clamped between 15s and 4 minutes so tiny/huge files stay sane.
  const estimatedTotalMs = Math.min(Math.max(sizeMb * 20000, 15000), 240000)
  const tau = estimatedTotalMs / 3
  const raw = 1 - Math.exp(-elapsedMs / tau)
  return Math.min(raw * 100, 96) // never claims 100% until the real status says so
}

function progressPhaseLabel(progress: number): string {
  if (progress < 8) return 'Reading document…'
  if (progress < 92) return 'Extracting & embedding chunks…'
  return 'Finalizing index…'
}


function renderTrailValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="trail-empty">—</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="trail-empty">None</span>
    return (
      <ul className="trail-value-list">
        {value.map((item, index) => <li key={index}>{renderTrailValue(item)}</li>)}
      </ul>
    )
  }
  if (typeof value === 'object') {
    return (
      <dl className="trail-nested">
        {Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => (
          <div key={key}>
            <dt>{formatLabel(key)}</dt>
            <dd>{renderTrailValue(nestedValue)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  if (typeof value === 'boolean') return <span className="trail-boolean">{value ? 'Yes' : 'No'}</span>
  return String(value)
}

function TrailStepCard({ step, index }: { step: Record<string, unknown>; index: number }) {
  return (
    <li className="trail-card">
      <span className="hop-index">Hop {index + 1}</span>
      <dl className="trail-fields">
        {Object.entries(step).map(([key, value]) => (
          <div key={key}>
            <dt>{formatLabel(key)}</dt>
            <dd>{renderTrailValue(value)}</dd>
          </div>
        ))}
      </dl>
    </li>
  )
}

function App() {
  const [query, setQuery] = useState('')
  const [webSearch, setWebSearch] = useState(false)
  const [deepResearch, setDeepResearch] = useState(false)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStage, setUploadStage] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const progressIntervalRef = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [result, setResult] = useState<AskResponse | null>(null)
  const [history, setHistory] = useState<Conversation[]>([])
  const [uploads, setUploads] = useState<Document[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [progressStage, setProgressStage] = useState(-1)
  const [progressState, setProgressState] = useState<ProgressState>('idle')
  const resultsRef = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typedAnswer = useTypewriter(result?.answer ?? '')

  useEffect(() => {
    if (!loading) return

    const interval = window.setInterval(() => {
      setProgressStage((current) => Math.min(current + 1, RESEARCH_STAGES.length - 1))
    }, 900)

    return () => window.clearInterval(interval)
  }, [loading])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed || loading || uploading) return

    setLoading(true)
    setError(null)
    setResult(null)
    setProgressStage(0)
    setProgressState('working')

    try {
      const data = await askQuestion(trimmed, history, { webSearch, deepResearch })
      setResult(data)
      setHistory((previous) => [
        ...previous,
        { question: trimmed, answer: data.answer },
      ])
      setProgressStage(RESEARCH_STAGES.length - 1)
      setProgressState('complete')
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setProgressState('error')
    } finally {
      setLoading(false)
    }
  }

  async function processFile(file: File) {
    if (uploading || loading) return

    const name = file.name.toLowerCase()
    if (!name.endsWith('.pdf')) {
      setUploadError('Only PDF files are supported.')
      return
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('File exceeds the 8 MB limit.')
      return
    }

    if (file.size === 0) {
      setUploadError('Uploaded file is empty.')
      return
    }

    setUploading(true)
    setUploadError(null)
    setUploadStage('Uploading…')
    setUploadProgress(0)

    const startTime = Date.now()
    const fileSize = file.size

    progressIntervalRef.current = window.setInterval(() => {
      setUploadProgress(estimateUploadProgress(Date.now() - startTime, fileSize))
    }, 200)

    try {
      const { job_id } = await uploadPdf(file)
      setUploadStage('Extracting & embedding…')
      const status = await pollUploadStatus(job_id)

      if (progressIntervalRef.current) window.clearInterval(progressIntervalRef.current)
      setUploadProgress(100)

      setUploads((prev) => [
        {
          doc_id: status.doc_id ?? job_id,
          filename: status.filename ?? file.name,
          chunks: status.chunks,
          pages: status.pages,
          path: status.path,
        },
        ...prev,
      ])
      // New document changes the retrieval context — stale conversation
      // history and the previously displayed answer no longer apply.
      setHistory([])
      setResult(null)
      setError(null)

    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      if (progressIntervalRef.current) window.clearInterval(progressIntervalRef.current)
      setUploading(false)
      window.setTimeout(() => {
        setUploadStage('')
        setUploadProgress(0)
      }, 700) // let the 100% moment flash briefly before resetting
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDeleteDocument(document: Document) {
    if (deletingId || busy) return
    setDeletingId(document.doc_id)
    setUploadError(null)
    try {
      await deleteDocument(document.doc_id)
      setUploads((prev) => prev.filter((item) => item.doc_id !== document.doc_id))
      setHistory([])
      setResult(null)
      setError(null)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not delete document.')
    } finally {
      setDeletingId(null)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void processFile(file)
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void processFile(file)
  }

  function handleClearSession() {
    setHistory([])
    setResult(null)
    setError(null)
    setProgressState('idle')
    setProgressStage(-1)
  }

  const busy = loading || uploading

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="grid-wash" />
      </div>

      <header className="hero">
        <p className="brand">ResX</p>
        <h1>Ask questions that need more than one leap.</h1>
        <p className="lede">
          Decompose complex queries, retrieve and verify evidence across hops,
          then synthesize cited answers from real sources.
        </p>

        <section className="upload-panel" aria-labelledby="upload-heading">
          <div className="upload-copy">
            <h2 id="upload-heading">Source PDFs</h2>
            <p>Drop a PDF to ingest it into the retrieval index before you ask.</p>
          </div>

          <label
            className={`dropzone${dragOver ? ' is-dragover' : ''}${uploading ? ' is-busy' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              setDragOver(false)
            }}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={handleFileChange}
              disabled={busy}
            />
            <span className="dropzone-title">
              {uploading ? (
                <>
                  <span className="spinner spinner-dark" aria-hidden="true" />
                  {uploadStage || 'Ingesting PDF…'}
                </>
              ) : (
                'Drop a PDF here, or browse'
              )}
            </span>
            <span className="dropzone-hint">PDF only · up to 8 MB</span>
          </label>

          {uploading && (
            <div className="upload-progress" role="progressbar" aria-valuenow={Math.round(uploadProgress)} aria-valuemin={0} aria-valuemax={100}>
              <div className="upload-progress-track">
                <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <div className="upload-progress-meta">
                <span>{progressPhaseLabel(uploadProgress)}</span>
                <span>{Math.round(uploadProgress)}%</span>
              </div>
            </div>
          )}

          {uploadError && (
            <div className="banner error upload-banner" role="alert">
              {uploadError}
            </div>
          )}

          {uploads.length > 0 && (
            <ul className="upload-list">
              {uploads.map((item) => (
                <li key={item.doc_id}>
                  <div>
                    <p className="upload-name">{item.filename}</p>
                    <p className="upload-meta">
                      {item.pages !== undefined ? `${item.pages} pages · ` : ''}
                      {item.chunks !== undefined ? `${item.chunks} chunks · ` : ''}ingested
                    </p>
                  </div>
                  <div className="upload-item-actions">
                    <span className="upload-badge">Ready</span>
                    <button
                      type="button"
                      className="remove-document"
                      onClick={() => void handleDeleteDocument(item)}
                      disabled={busy || deletingId !== null}
                      aria-label={`Remove ${item.filename}`}
                    >
                      {deletingId === item.doc_id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form className="ask-form" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="query">
            Research question
          </label>
          <textarea
            id="query"
            name="query"
            rows={3}
            maxLength={300}
            placeholder="What multi-hop research question should we chase?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={busy}
          />
          <div className="ask-actions">
            <span className="char-count">{query.length}/300</span>
            {(history.length > 0 || result) && (
              <button
                type="button"
                className="clear-session-btn"
                onClick={handleClearSession}
                disabled={busy}
              >
                <svg className="clear-session-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z" />
                </svg>
                New session
              </button>
            )}
            <button type="submit" disabled={busy || !query.trim()}>
              {loading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Researching…
                </>
              ) : (
                'Start research'
              )}
            </button>
          </div>
          <div className="research-mode-options" role="group" aria-label="Research modes">
            <button
              type="button"
              className={`mode-chip${webSearch ? ' is-selected' : ''}`}
              aria-pressed={webSearch}
              onClick={() => setWebSearch((selected) => !selected)}
              disabled={busy}
            >
              <svg className="mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
              </svg>
              Web search
            </button>
            <button
              type="button"
              className={`mode-chip${deepResearch ? ' is-selected' : ''}`}
              aria-pressed={deepResearch}
              onClick={() => setDeepResearch((selected) => !selected)}
              disabled={busy}
            >
              <svg className="mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" />
                <path d="m19 15 .75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75L19 15Z" />
              </svg>
              Deep research
            </button>
          </div>
        </form>

        <div className="examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="example"
              disabled={busy}
              onClick={() => setQuery(example)}
            >
              {example}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {progressState !== 'idle' && (
        <div className={`research-status is-${progressState}`} role="status" aria-live="polite">
          <span className="research-status-loader" aria-hidden="true" />
          <span className="research-status-text">
            {progressState === 'complete' ? (
              <><strong>Research complete</strong><span>The answer is ready</span></>
            ) : progressState === 'error' ? (
              <><strong>Research stopped</strong><span>Please try the request again</span></>
            ) : (
              <><strong>{RESEARCH_STAGES[progressStage]?.label ?? 'Working'}</strong><span>{RESEARCH_STAGES[progressStage]?.detail}</span></>
            )}
          </span>
        </div>
      )}

      {result && (
        <section className="results" ref={resultsRef} aria-live="polite">
          <div className="result-head">
            <h2>Synthesized answer</h2>
            <p className="confidence">
              Confidence{' '}
              <strong>{Math.round(result.confidence * 100)}%</strong>
            </p>
          </div>

          <article className="answer prose">
            <MarkdownContent text={typedAnswer.text} />
            {typedAnswer.isTyping && <span className="typewriter-cursor" aria-hidden="true" />}
          </article>

          {result.trail.length > 0 && (
            <section className="trail">
              <h3>Research trail</h3>
              <ol>
                {result.trail.map((step, index) => (
                  <TrailStepCard key={index} step={step} index={index} />
                ))}
              </ol>
            </section>
          )}

          {result.citations.length > 0 && (
            <section className="sources">
              <h3>Sources</h3>
              <ul>
                {result.citations.map((citation) => (
                  <li key={citation.id}>
                    <details className="source-details">
                      <summary>
                        <span className="source-summary-title">
                          <strong>[{citation.id}]</strong>{' '}
                          {citation.title ?? citation.source}
                        </span>
                        <span className="source-summary-meta">
                          {citation.source_type === 'web' ? 'Web source' : 'Document'}
                          {citation.page !== null && ` · Page ${citation.page}`}
                        </span>
                      </summary>
                      <div className="source-evidence">
                        <p className="source-location">
                          {citation.source}
                          {citation.page !== null && ` · Page ${citation.page}`}
                          {citation.url && (
                            <> · <a href={citation.url} target="_blank" rel="noopener noreferrer">Open source</a></>
                          )}
                        </p>
                        <p className="evidence-label">Retrieved evidence</p>
                        <p className="evidence-text">{citation.content || 'No evidence excerpt was returned for this source.'}</p>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="groundedness">
            <h3>Groundedness check</h3>
            <p>
              <strong>{result.groundedness.verdict.replace('_', ' ')}</strong>{' '}
              ({Math.round(result.groundedness.score * 100)}%)
            </p>
            {result.groundedness.reasoning && <p className="groundedness-reasoning">{result.groundedness.reasoning}</p>}
            {result.groundedness.unsupported_claims.length > 0 && (
              <ul>
                {result.groundedness.unsupported_claims.map((claim, i) => (
                  <li key={i}>⚠ {claim}</li>
                ))}
              </ul>
            )}
          </section>
        
          <section className="stats">
            <h3>Query stats</h3>
            <ul className="stats-list">
              <li>Retrieval calls: <strong>{result.retrieval_calls}</strong></li>
              <li>Web search calls: <strong>{result.web_search_calls}</strong></li>
              <li>PDF evidence: <strong>{result.document_evidence_count ?? 0}</strong></li>
              <li>Web evidence: <strong>{result.web_evidence_count ?? 0}</strong></li>
              <li>LLM calls: <strong>{result.llm_calls}</strong></li>
            </ul>
          </section>
        </section>
      )}

      <footer className="footer">
        <p>ResX</p>
      </footer>
    </div>
  )
}

export default App
