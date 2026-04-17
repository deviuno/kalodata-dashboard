import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft, ExternalLink, ShoppingBag, RefreshCw,
  ChevronLeft, ChevronRight, Clock, Megaphone, DollarSign,
  PlayCircle, Star, Play, Users, Package,
} from 'lucide-react'
import VideoPlayerModal from './VideoPlayerModal'
import {
  fetchProductDetail, fetchProductTotal, fetchProductVideos,
  getDateRange, type ProductTotal,
} from '../lib/kalodata'

interface Props {
  productId: string
  productTitle?: string
  onBack: () => void
}

const DATE_OPTIONS = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
]

const PAGE_SIZE = 10

export default function ProductDetail({ productId, productTitle, onBack }: Props) {
  const [days, setDays] = useState(7)
  const [detail, setDetail] = useState<any>(null)
  const [totals, setTotals] = useState<ProductTotal | null>(null)
  const [videos, setVideos] = useState<any[]>([])
  const [loadingDetail, setLoadingDetail] = useState(true)
  const [loadingVideos, setLoadingVideos] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [sortField, setSortField] = useState('revenue')
  const [playerVideoId, setPlayerVideoId] = useState<string | null>(null)
  const [coverError, setCoverError] = useState(false)

  const range = getDateRange(days)

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true)
    try {
      const [d, t] = await Promise.all([
        fetchProductDetail(productId, days),
        fetchProductTotal(productId, days),
      ])
      setDetail(d)
      setTotals(t)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingDetail(false)
    }
  }, [productId, days])

  const loadVideos = useCallback(async () => {
    setLoadingVideos(true)
    setError(null)
    try {
      const data = await fetchProductVideos(productId, days, page, PAGE_SIZE, sortField)
      setVideos(Array.isArray(data) ? data : [])
    } catch (e: any) {
      const msg = e.message || 'Erro desconhecido'
      if (msg.includes('DATE_SPACING') || msg.includes('exceeds span')) {
        setError(`Periodo de ${days} dias nao permitido no plano atual.`)
      } else {
        setError(msg)
      }
    } finally {
      setLoadingVideos(false)
    }
  }, [productId, days, page, sortField])

  useEffect(() => { loadDetail() }, [loadDetail])
  useEffect(() => { loadVideos() }, [loadVideos])
  useEffect(() => { setPage(1) }, [days, sortField])

  const title = detail?.product_title || productTitle || 'Produto'
  const tiktokShopUrl = `https://shop.tiktok.com/view/product/${productId}`

  return (
    <div className="creator-detail">
      {/* BACK HEADER */}
      <div className="cd-back-bar">
        <button className="cd-back-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Voltar para Produtos
        </button>
        <div className="date-filter">
          <Clock size={14} />
          {DATE_OPTIONS.map(opt => (
            <button
              key={opt.days}
              className={`date-btn ${days === opt.days ? 'active' : ''}`}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* PRODUCT HEADER */}
      <div className="cd-profile">
        <div className="cd-profile-left">
          <div className="cd-avatar" style={{ borderRadius: 12 }}>
            {!coverError ? (
              <img
                src={`/api/product/${productId}/image`}
                alt={title}
                className="cd-avatar-img"
                style={{ borderRadius: 12, objectFit: 'cover' }}
                onError={() => setCoverError(true)}
              />
            ) : (
              <Package size={32} />
            )}
          </div>
          <div className="cd-profile-info">
            <h2 className="cd-name">{title}</h2>
            <div className="cd-meta-tags">
              {detail?.pri_cate_id && (
                <span className="card-tag tag-blue">{detail.pri_cate_id}</span>
              )}
              {detail?.sec_cate_id && detail.sec_cate_id !== detail.pri_cate_id && (
                <span className="card-tag tag-accent">{detail.sec_cate_id}</span>
              )}
              {detail?.ter_cate_id && (
                <span className="card-tag tag-pink">{detail.ter_cate_id}</span>
              )}
              {detail?.product_rating && (
                <span className="card-tag tag-orange" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Star size={10} fill="currentColor" /> {detail.product_rating}
                  {detail.review_count ? ` (${detail.review_count})` : ''}
                </span>
              )}
              {detail?.commission_rate && detail.commission_rate !== '-' && (
                <span className="card-tag tag-orange">Comissao {detail.commission_rate}</span>
              )}
              {detail?.brand_name && (
                <span className="card-tag tag-accent">{detail.brand_name}</span>
              )}
            </div>
            {detail?.unit_price && (
              <p className="cd-bio">
                <strong>Preco:</strong> {detail.unit_price}
                {detail.min_real_price && detail.max_real_price && detail.min_real_price !== detail.max_real_price && (
                  <> ({detail.min_real_price} - {detail.max_real_price})</>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="cd-profile-right">
          <a className="cd-tiktok-btn" href={tiktokShopUrl} target="_blank" rel="noopener noreferrer">
            TikTok Shop <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* STATS OVERVIEW */}
      <div className="cd-stats-grid">
        <div className="cd-stat-card">
          <div className="cd-stat-icon green"><DollarSign size={18} /></div>
          <div>
            <span className="cd-stat-label">Receita Total</span>
            <span className="cd-stat-value">{totals?.revenue || '-'}</span>
            {totals?.day_revenue && <span className="cd-stat-daily">Hoje: {totals.day_revenue}</span>}
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon accent"><ShoppingBag size={18} /></div>
          <div>
            <span className="cd-stat-label">Vendas</span>
            <span className="cd-stat-value">{totals?.sale || '-'}</span>
            {totals?.day_sale && <span className="cd-stat-daily">Hoje: {totals.day_sale}</span>}
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon orange"><PlayCircle size={18} /></div>
          <div>
            <span className="cd-stat-label">Receita Videos</span>
            <span className="cd-stat-value">{totals?.video_revenue || '-'}</span>
            {totals?.day_video_revenue && <span className="cd-stat-daily">Hoje: {totals.day_video_revenue}</span>}
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon pink"><Megaphone size={18} /></div>
          <div>
            <span className="cd-stat-label">Receita Lives</span>
            <span className="cd-stat-value">{totals?.live_revenue || '-'}</span>
            {totals?.day_live_revenue && <span className="cd-stat-daily">Hoje: {totals.day_live_revenue}</span>}
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon blue"><ShoppingBag size={18} /></div>
          <div>
            <span className="cd-stat-label">Shopping Mall</span>
            <span className="cd-stat-value">{totals?.shopping_mall_revenue || '-'}</span>
            {totals?.day_shopping_mall_revenue && <span className="cd-stat-daily">Hoje: {totals.day_shopping_mall_revenue}</span>}
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon blue"><Users size={18} /></div>
          <div>
            <span className="cd-stat-label">Criadores</span>
            <span className="cd-stat-value">{totals?.related_creator_count?.toLocaleString('pt-BR') || '-'}</span>
            {typeof totals?.creatorConversionRatio === 'number' && (
              <span className="cd-stat-daily">Conversao: {(totals.creatorConversionRatio * 100).toFixed(1)}%</span>
            )}
          </div>
        </div>
      </div>

      {/* VIDEOS / ADS SECTION */}
      <h3 className="cd-videos-title">
        <Megaphone size={15} /> Anuncios do produto
      </h3>

      {/* SORT */}
      <div className="cd-sub-tabs">
        <div className="cd-sort-group">
          <span className="cd-sort-label">Ordenar:</span>
          {[
            { key: 'revenue', label: 'Receita' },
            { key: 'views', label: 'Views' },
            { key: 'sale', label: 'Vendas' },
            { key: 'gpm', label: 'GPM' },
          ].map(s => (
            <button
              key={s.key}
              className={`cd-sort-btn ${sortField === s.key ? 'active' : ''}`}
              onClick={() => setSortField(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <span className="cd-date-range">{range.startDate} → {range.endDate}</span>
      </div>

      {/* VIDEOS TABLE */}
      <div className="cd-content">
        {loadingVideos && (
          <div className="state-msg">
            <RefreshCw size={24} className="spin" />
            <span>Carregando videos...</span>
          </div>
        )}

        {error && !loadingVideos && (
          <div className="state-msg error"><span>{error}</span></div>
        )}

        {!loadingVideos && !error && (
          <div className="cd-table-wrap">
            {videos.length === 0 ? (
              <div className="state-msg">Nenhum video encontrado no periodo.</div>
            ) : (
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Video</th>
                    <th>Receita</th>
                    <th>Vendas</th>
                    <th>Views</th>
                    <th>GPM</th>
                    <th>Tipo</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v, i) => {
                    const vid = v.id
                    return (
                      <tr key={vid || i}>
                        <td className="cd-td-rank">{(page - 1) * PAGE_SIZE + i + 1}</td>
                        <td className="cd-td-desc">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <div
                              className="cd-video-thumb-wrap cd-video-thumb-clickable"
                              onClick={() => setPlayerVideoId(vid)}
                            >
                              <img
                                src={`/api/video/${vid}/cover`}
                                alt=""
                                className="cd-video-thumb"
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                loading="lazy"
                              />
                              <div className="cd-video-thumb-play"><Play size={14} /></div>
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <span className="cd-video-title">{v.description || 'Sem descricao'}</span>
                              {v.duration && <span className="cd-video-duration">{v.duration}</span>}
                            </div>
                          </div>
                        </td>
                        <td className="cd-td-revenue">{v.revenue || '-'}</td>
                        <td className="cd-td-sales">{typeof v.sale === 'number' ? v.sale.toLocaleString('pt-BR') : v.sale || '-'}</td>
                        <td className="cd-td-views">{v.views || '-'}</td>
                        <td className="cd-td-gpm">
                          {typeof v.gpm === 'number' ? `R$${v.gpm.toFixed(2)}` : v.gpm || '-'}
                        </td>
                        <td className="cd-td-ads">
                          {v.ad === 1 && (
                            <span className="cd-ad-badge"><Megaphone size={10} /> Ad</span>
                          )}
                        </td>
                        <td className="cd-td-date">{v.create_time ? formatDate(v.create_time) : '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* PAGINATION */}
      {videos.length > 0 && !loadingVideos && (
        <div className="pagination">
          <button className="page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft size={16} /> Anterior
          </button>
          <span className="page-info">Pagina {page}</span>
          <button className="page-btn" disabled={videos.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>
            Proxima <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* VIDEO PLAYER */}
      {playerVideoId && (
        <VideoPlayerModal
          videoId={playerVideoId}
          title={title}
          onClose={() => setPlayerVideoId(null)}
          useKaloData
        />
      )}

      {loadingDetail && !detail && (
        <div className="state-msg"><RefreshCw size={20} className="spin" /> Carregando detalhes...</div>
      )}
    </div>
  )
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split(' ')[0]?.split('/')
  if (parts?.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`
  return dateStr
}
