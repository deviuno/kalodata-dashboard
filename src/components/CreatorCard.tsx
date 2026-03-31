import { ExternalLink, Users, Video, ShoppingBag } from 'lucide-react'

function rankClass(rank: number) {
  if (rank === 1) return 'rank-1'
  if (rank === 2) return 'rank-2'
  if (rank === 3) return 'rank-3'
  return 'rank-default'
}

export default function CreatorCard({ creator: c, rank }: { creator: any; rank: number }) {
  const initial = (c.handle || c.nickname || '?')[0].toUpperCase()
  const tiktokUrl = `https://www.tiktok.com/@${c.handle}`

  return (
    <div className="card" style={{ animationDelay: `${rank * 0.03}s` }}>
      <div className="card-top">
        <div className={`card-rank ${rankClass(rank)}`}>{rank}</div>
        <div className="creator-avatar">{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">{c.nickname || c.handle}</div>
          <span className="handle">@{c.handle}</span>
        </div>
      </div>

      <div className="card-stats">
        <div className="stat">
          <span className="stat-label">Receita</span>
          <span className="stat-val green">{c.revenue || '-'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Vendas</span>
          <span className="stat-val accent">{c.sale?.toLocaleString('pt-BR') ?? '-'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Seguidores</span>
          <span className="stat-val blue">{c.follower_count || '-'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Vídeos</span>
          <span className="stat-val orange">{c.video_count || c.video_num || '-'}</span>
        </div>
      </div>

      <div className="card-footer">
        <div style={{ display: 'flex', gap: 8 }}>
          {c.cate_id && <span className="card-tag tag-accent">{c.cate_id}</span>}
        </div>
        <a className="card-link" href={tiktokUrl} target="_blank" rel="noopener noreferrer">
          Perfil <ExternalLink size={11} />
        </a>
      </div>
    </div>
  )
}
