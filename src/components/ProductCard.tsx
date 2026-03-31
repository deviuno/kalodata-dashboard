import { ExternalLink, Star } from 'lucide-react'

function rankClass(rank: number) {
  if (rank === 1) return 'rank-1'
  if (rank === 2) return 'rank-2'
  if (rank === 3) return 'rank-3'
  return 'rank-default'
}

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length === 0) return null
  const max = Math.max(...data, 1)
  return (
    <div className="sparkline">
      {data.map((v, i) => (
        <div key={i} className="spark-bar" style={{ height: `${(v / max) * 100}%` }} />
      ))}
    </div>
  )
}

export default function ProductCard({ product: p, rank }: { product: any; rank: number }) {
  return (
    <div className="card" style={{ animationDelay: `${rank * 0.03}s` }}>
      <div className="card-top">
        <div className={`card-rank ${rankClass(rank)}`}>{rank}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">{p.product_title}</div>
          <div className="card-category">{p.cate_id || p.pri_cate_id}</div>
        </div>
        <Sparkline data={p.revenue_trend} />
      </div>

      <div className="card-stats">
        <div className="stat">
          <span className="stat-label">Receita</span>
          <span className="stat-val green">{p.revenue}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Vendas</span>
          <span className="stat-val accent">{p.sale?.toLocaleString('pt-BR') ?? '-'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Preço</span>
          <span className="stat-val">{p.unit_price || `${p.min_real_price} - ${p.max_real_price}`}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Criadores</span>
          <span className="stat-val blue">{p.creator_num?.toLocaleString('pt-BR') ?? '-'}</span>
        </div>
      </div>

      <div className="card-footer">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {p.commission_rate && p.commission_rate !== '-' && (
            <span className="card-tag tag-orange">Comissão {p.commission_rate}</span>
          )}
          {p.product_rating && (
            <span className="card-tag tag-accent" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <Star size={10} fill="currentColor" /> {p.product_rating}
            </span>
          )}
        </div>
        {p.revenue_grouping_rate && (
          <span className={`growth ${parseFloat(p.revenue_grouping_rate) >= 0 ? 'up' : 'down'}`}>
            {parseFloat(p.revenue_grouping_rate) >= 0 ? '↑' : '↓'} {p.revenue_grouping_rate}
          </span>
        )}
      </div>
    </div>
  )
}
