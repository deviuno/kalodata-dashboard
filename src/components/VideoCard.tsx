import { useState, useEffect, useRef, useCallback } from 'react'
import { Clock, ExternalLink, Play, X, FileText, Lightbulb, Loader, Download } from 'lucide-react'

function rankClass(rank: number) {
  if (rank === 1) return 'rank-1'
  if (rank === 2) return 'rank-2'
  if (rank === 3) return 'rank-3'
  return 'rank-default'
}

function buildVTT(transcript: any): string {
  const lines: string[] = ['WEBVTT', '']
  if (!transcript?.video_scripts) return lines.join('\n')

  let cueIndex = 1
  for (const scene of transcript.video_scripts) {
    if (!scene.audio_script) continue
    for (const line of scene.audio_script) {
      const start = formatVTTTime(line.start_time)
      const end = formatVTTTime(line.end_time)
      const text = line.translate_script || line.script
      lines.push(`${cueIndex}`, `${start} --> ${end}`, text, '')
      cueIndex++
    }
  }
  return lines.join('\n')
}

function formatVTTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}.000`
}

interface Props {
  video: any
  rank: number
  type: 'hot' | 'selling'
}

export default function VideoCard({ video: v, rank, type }: Props) {
  const [showModal, setShowModal] = useState(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<any>(null)
  const [vttUrl, setVttUrl] = useState<string | null>(null)
  const [loadingVideo, setLoadingVideo] = useState(false)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [videoNotFound, setVideoNotFound] = useState(false)
  const [transcriptNotFound, setTranscriptNotFound] = useState(false)
  const [generatingTranscript, setGeneratingTranscript] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const activeLineRef = useRef<HTMLDivElement>(null)

  const isHot = type === 'hot'
  const videoId = v.video_id || v.id
  const tiktokUrl = `https://www.tiktok.com/@${v.handle}/video/${videoId}`

  useEffect(() => {
    return () => { if (vttUrl) URL.revokeObjectURL(vttUrl) }
  }, [vttUrl])

  // Auto-scroll to active line
  useEffect(() => {
    if (activeLineRef.current && showAnalysis) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentTime, showAnalysis])

  const onTimeUpdate = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
  }, [])

  function seekTo(time: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = time
      videoRef.current.play()
    }
  }

  async function openModal() {
    setShowModal(true)
    setError(null)
    setShowAnalysis(false)
    setVideoNotFound(false)
    setTranscriptNotFound(false)
    setCurrentTime(0)

    const fetchVideo = async () => {
      if (videoUrl) return
      setLoadingVideo(true)
      try {
        const res = await fetch(`/api/insight/${videoId}/url`)
        const json = await res.json()
        if (json.success && json.data?.url) {
          setVideoUrl(json.data.url)
        } else if (json.message === 'file not found') {
          setVideoNotFound(true)
        } else {
          setError('Nao foi possivel carregar o video')
        }
      } catch {
        setError('Erro ao buscar video')
      } finally {
        setLoadingVideo(false)
      }
    }

    const fetchTranscript = async () => {
      if (transcript) return
      setLoadingTranscript(true)
      try {
        const res = await fetch(`/api/insight/${videoId}/transcript?translate=true`)
        const json = await res.json()
        if (json.success && json.data?.video_scripts) {
          setTranscript(json.data)
          const vtt = buildVTT(json.data)
          const blob = new Blob([vtt], { type: 'text/vtt' })
          setVttUrl(URL.createObjectURL(blob))
        } else if (!json.success || !json.data?.video_scripts) {
          setTranscriptNotFound(true)
        }
      } catch {
        // subtitles won't show, video still works
      } finally {
        setLoadingTranscript(false)
      }
    }

    await Promise.all([fetchVideo(), fetchTranscript()])
  }

  useEffect(() => {
    if (!videoRef.current || !vttUrl) return
    const video = videoRef.current
    const tryEnable = () => {
      if (video.textTracks.length > 0) {
        video.textTracks[0].mode = 'showing'
      }
    }
    tryEnable()
    video.addEventListener('loadedmetadata', tryEnable)
    return () => video.removeEventListener('loadedmetadata', tryEnable)
  }, [vttUrl, videoUrl])

  // Check if a scene is active
  function isSceneActive(scene: any) {
    return currentTime >= scene.start_time && currentTime <= scene.end_time
  }

  // Check if a script line is active
  function isLineActive(line: any) {
    return currentTime >= line.start_time && currentTime < line.end_time
  }

  return (
    <>
      <div className="card" style={{ animationDelay: `${rank * 0.03}s` }}>
        <div className="card-top">
          <div className={`card-rank ${rankClass(rank)}`}>{rank}</div>
          <div className="video-thumb-wrapper" onClick={openModal}>
            <img
              src={`/api/video/${videoId}/cover`}
              alt=""
              className="video-thumb"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              loading="lazy"
            />
            <div className="video-thumb-play"><Play size={16} /></div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="handle">@{v.handle}</span>
            {isHot && v.cate_id && <div className="card-category">{v.cate_id}</div>}
            {!isHot && v.publish_date && (
              <div className="card-category">
                <Clock size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                {v.publish_date}
              </div>
            )}
          </div>
        </div>

        {!isHot && v.description && (
          <div className="video-desc">{v.description}</div>
        )}

        <div className="card-stats">
          {isHot ? (
            <>
              <div className="stat">
                <span className="stat-label">Receita</span>
                <span className="stat-val green">{v.revenue}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Produtos</span>
                <span className="stat-val accent">{v.productCount ?? '-'}</span>
              </div>
            </>
          ) : (
            <>
              <div className="stat">
                <span className="stat-label">Views</span>
                <span className="stat-val blue">{v.views}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Receita</span>
                <span className="stat-val green">{v.revenue}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Vendas</span>
                <span className="stat-val accent">{v.sale?.toLocaleString('pt-BR') ?? '-'}</span>
              </div>
              <div className="stat">
                <span className="stat-label">GPM</span>
                <span className="stat-val orange">{v.gpm || '-'}</span>
              </div>
            </>
          )}
        </div>

        <div className="card-footer">
          <div style={{ display: 'flex', gap: 8 }}>
            {!isHot && v.duration && (
              <span className="card-tag tag-blue">{v.duration}</span>
            )}
            {v.ad === 1 && <span className="card-tag tag-pink">AD</span>}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="card-link" onClick={openModal} style={{ border: 'none', background: 'none', padding: 0, fontFamily: 'inherit' }}>
              <Play size={11} /> Player
            </button>
            <a className="card-link" href={tiktokUrl} target="_blank" rel="noopener noreferrer">
              TikTok <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="video-modal-overlay" onClick={() => setShowModal(false)}>
          <div className={`video-modal ${showAnalysis ? 'with-analysis' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="video-modal-header">
              <span className="handle">@{v.handle}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {transcriptNotFound && !generatingTranscript && (
                  <button
                    className="analysis-toggle-btn"
                    onClick={async () => {
                      setGeneratingTranscript(true)
                      try {
                        // Dispara a geracao
                        await fetch(`/api/insight/${videoId}/transcript`, { method: 'POST' })
                        // Polling: espera a transcricao ficar pronta (max 60s)
                        for (let i = 0; i < 12; i++) {
                          await new Promise(r => setTimeout(r, 5000))
                          const res = await fetch(`/api/insight/${videoId}/transcript?translate=true`)
                          const json = await res.json()
                          if (json.success && json.data?.video_scripts) {
                            setTranscript(json.data)
                            setTranscriptNotFound(false)
                            const vtt = buildVTT(json.data)
                            const blob = new Blob([vtt], { type: 'text/vtt' })
                            setVttUrl(URL.createObjectURL(blob))
                            break
                          }
                        }
                      } catch { /* */ }
                      finally { setGeneratingTranscript(false) }
                    }}
                  >
                    <FileText size={13} /> Gerar Transcricao
                  </button>
                )}
                {generatingTranscript && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text3)' }}>
                    <Loader size={12} className="spin" /> Gerando transcricao...
                  </span>
                )}
                {transcript && !showAnalysis && (
                  <button className="analysis-toggle-btn" onClick={() => setShowAnalysis(true)}>
                    <Lightbulb size={13} /> Analise
                  </button>
                )}
                {showAnalysis && (
                  <button className="analysis-toggle-btn active" onClick={() => setShowAnalysis(false)}>
                    <X size={13} /> Fechar analise
                  </button>
                )}
                <button className="video-modal-close" onClick={() => setShowModal(false)}>
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="modal-content">
              <div className="modal-video-col">
                {loadingVideo && (
                  <div className="modal-loading">
                    <Loader size={24} className="spin" />
                    <span>Carregando video...</span>
                  </div>
                )}
                {error && (
                  <div className="modal-loading">
                    <span style={{ color: 'var(--red)' }}>{error}</span>
                  </div>
                )}
                {videoNotFound && !loadingVideo && !videoUrl && (
                  <div className="modal-loading">
                    <p style={{ color: 'var(--text2)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                      Video nao disponivel no cache.
                    </p>
                    <button
                      className="export-btn"
                      onClick={async () => {
                        setExporting(true)
                        try {
                          const res = await fetch(`/api/insight/${videoId}/export`, { method: 'POST' })
                          const json = await res.json()
                          if (json.success && json.data?.url) {
                            setVideoUrl(json.data.url)
                            setVideoNotFound(false)
                          } else {
                            setError(json.message || 'Falha ao exportar')
                          }
                        } catch {
                          setError('Erro ao exportar video')
                        } finally {
                          setExporting(false)
                        }
                      }}
                      disabled={exporting}
                    >
                      {exporting ? <Loader size={14} className="spin" /> : <Download size={14} />}
                      {exporting ? 'Exportando...' : 'Exportar Video'}
                    </button>
                    <p style={{ color: 'var(--text3)', fontSize: 11, marginTop: 8 }}>
                      Consome creditos da conta Kalowave
                    </p>
                  </div>
                )}
                {videoUrl && !loadingVideo && (
                  <video
                    ref={videoRef}
                    className="modal-video"
                    src={videoUrl}
                    controls
                    autoPlay
                    playsInline
                    onTimeUpdate={onTimeUpdate}
                  >
                    {vttUrl && (
                      <track
                        kind="subtitles"
                        src={vttUrl}
                        srcLang="pt"
                        label="Legendas"
                        default
                      />
                    )}
                  </video>
                )}
                {loadingTranscript && !loadingVideo && videoUrl && (
                  <div className="subtitle-loading">
                    <Loader size={12} className="spin" /> Carregando legendas...
                  </div>
                )}
              </div>

              {showAnalysis && transcript && (
                <div className="modal-transcript-col">
                  <div className="transcript-content">
                    {(transcript.translate_key_to_success_list || transcript.key_to_success_list) && (
                      <div className="transcript-section">
                        <div className="transcript-section-title">
                          <Lightbulb size={14} /> Chave do Sucesso
                        </div>
                        {(transcript.translate_key_to_success_list || transcript.key_to_success_list).map((item: string, i: number) => (
                          <p key={i} className="transcript-tip">{item.trim()}</p>
                        ))}
                      </div>
                    )}

                    {transcript.video_scripts && (
                      <div className="transcript-section">
                        <div className="transcript-section-title">
                          <FileText size={14} /> Roteiro
                        </div>
                        {transcript.video_scripts.map((scene: any, i: number) => {
                          const sceneActive = isSceneActive(scene)
                          return (
                            <div
                              key={i}
                              className={`transcript-scene ${sceneActive ? 'scene-active' : ''}`}
                            >
                              <div className="scene-header" onClick={() => seekTo(scene.start_time)} style={{ cursor: 'pointer' }}>
                                <span className="scene-name">{scene.translate_scene || scene.scene}</span>
                                <span className="scene-time">{scene.start_time}s - {scene.end_time}s</span>
                              </div>
                              {(scene.translate_visual_description || scene.visual_description) && (
                                <p className="scene-visual">{scene.translate_visual_description || scene.visual_description}</p>
                              )}
                              {scene.audio_script?.map((line: any, j: number) => {
                                const lineActive = isLineActive(line)
                                return (
                                  <div
                                    key={j}
                                    ref={lineActive ? activeLineRef : undefined}
                                    className={`script-line ${lineActive ? 'line-active' : ''}`}
                                    onClick={() => seekTo(line.start_time)}
                                    style={{ cursor: 'pointer' }}
                                  >
                                    <span className="script-time">{line.start_time}s</span>
                                    <span className="script-text">{line.translate_script || line.script}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <div className="transcript-meta">
                      {transcript.language && <span className="card-tag tag-blue">{transcript.language}</span>}
                      {transcript.gender && <span className="card-tag tag-accent">{transcript.gender}</span>}
                    </div>
                    {(transcript.translate_camera_work || transcript.camera_work) && (
                      <div className="transcript-section" style={{ marginTop: 12 }}>
                        <div className="transcript-section-title">Camera</div>
                        <p className="scene-visual">{transcript.translate_camera_work || transcript.camera_work}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
