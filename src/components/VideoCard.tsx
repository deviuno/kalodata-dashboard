import { useState } from 'react'
import { Clock, ExternalLink, Play, Video } from 'lucide-react'
import VideoPlayerModal from './VideoPlayerModal'

function rankClass(rank: number) {
  if (rank === 1) return 'rank-1'
  if (rank === 2) return 'rank-2'
  if (rank === 3) return 'rank-3'
  return 'rank-default'
}

interface Props {
  video: any
  rank: number
  type: 'hot' | 'selling'
}

export default function VideoCard({ video: v, rank, type }: Props) {
  const [showModal, setShowModal] = useState(false)
  const [thumbError, setThumbError] = useState(false)

  const isHot = type === 'hot'
  const videoId = v.video_id || v.id
  const tiktokUrl = `https://www.tiktok.com/@${v.handle}/video/${videoId}`

  return (
    <>
      <div className="card" style={{ animationDelay: `${rank * 0.03}s` }}>
        <div className="card-top">
          <div className={`card-rank ${rankClass(rank)}`}>{rank}</div>
          <div className="video-thumb-wrapper" onClick={() => setShowModal(true)}>
            {thumbError ? (
              <div className="video-thumb-fallback"><Video size={20} /></div>
            ) : (
              <img
                src={`/api/video/${videoId}/cover`}
                alt=""
                className="video-thumb"
                onError={() => setThumbError(true)}
                loading="lazy"
              />
            )}
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
            <button className="card-link" onClick={() => setShowModal(true)} style={{ border: 'none', background: 'none', padding: 0, fontFamily: 'inherit' }}>
              <Play size={11} /> Player
            </button>
            <a className="card-link" href={tiktokUrl} target="_blank" rel="noopener noreferrer">
              TikTok <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>

      {showModal && (
        <VideoPlayerModal
          videoId={videoId}
          title={`@${v.handle}`}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}
