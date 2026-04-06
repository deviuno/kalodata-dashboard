import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, FileText, Lightbulb, Loader, Download } from 'lucide-react'

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
  videoId: string
  title?: string
  onClose: () => void
  /** Use KaloData getVideoUrl (GET) instead of Kalowave insight API */
  useKaloData?: boolean
}

export default function VideoPlayerModal({ videoId, title, onClose, useKaloData }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<any>(null)
  const [vttUrl, setVttUrl] = useState<string | null>(null)
  const [loadingVideo, setLoadingVideo] = useState(true)
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

  useEffect(() => {
    return () => { if (vttUrl) URL.revokeObjectURL(vttUrl) }
  }, [vttUrl])

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

  useEffect(() => {
    const fetchVideo = async () => {
      setLoadingVideo(true)
      try {
        const url = useKaloData
          ? `/api/video/${videoId}/url`
          : `/api/insight/${videoId}/url`
        const res = await fetch(url)
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
      setLoadingTranscript(true)
      try {
        const res = await fetch(`/api/insight/${videoId}/transcript?translate=true`)
        const json = await res.json()
        if (json.success && json.data?.video_scripts) {
          setTranscript(json.data)
          const vtt = buildVTT(json.data)
          const blob = new Blob([vtt], { type: 'text/vtt' })
          setVttUrl(URL.createObjectURL(blob))
        } else {
          setTranscriptNotFound(true)
        }
      } catch {
        setTranscriptNotFound(true)
      } finally {
        setLoadingTranscript(false)
      }
    }

    fetchVideo()
    fetchTranscript()
  }, [videoId, useKaloData])

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

  function isSceneActive(scene: any) {
    return currentTime >= scene.start_time && currentTime <= scene.end_time
  }

  function isLineActive(line: any) {
    return currentTime >= line.start_time && currentTime < line.end_time
  }

  return createPortal(
    <div className="video-modal-overlay" onClick={onClose}>
      <div className={`video-modal ${showAnalysis ? 'with-analysis' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="video-modal-header">
          <span className="handle">{title || 'Video'}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {transcriptNotFound && !generatingTranscript && (
              <button
                className="analysis-toggle-btn"
                onClick={async () => {
                  setGeneratingTranscript(true)
                  try {
                    await fetch(`/api/insight/${videoId}/transcript`, { method: 'POST' })
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
            <button className="video-modal-close" onClick={onClose}>
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
    </div>,
    document.body,
  )
}
