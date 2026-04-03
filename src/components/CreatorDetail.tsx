import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft, ExternalLink, Users, Video, ShoppingBag, TrendingUp,
  RefreshCw, ChevronLeft, ChevronRight,
  Calendar, Megaphone, Clock, Heart,
} from 'lucide-react'
import {
  fetchCreatorDetail, fetchCreatorVideos, fetchCreatorLives,
  fetchTikTokProfile, getDateRange, type TikTokProfile,
} from '../lib/kalodata'

interface Props {
  creatorId: string
  creatorHandle?: string
  creatorNickname?: string
  onBack: () => void
}

const DATE_OPTIONS = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
]

type SubTab = 'videos' | 'lives'

export default function CreatorDetail({ creatorId, creatorHandle, creatorNickname, onBack }: Props) {
  const [days, setDays] = useState(7)
  const [profile, setProfile] = useState<any>(null)
  const [videos, setVideos] = useState<any[]>([])
  const [lives, setLives] = useState<any[]>([])
  const [, setLoadingProfile] = useState(true)
  const [loadingContent, setLoadingContent] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('videos')
  const [videoPage, setVideoPage] = useState(1)
  const [livePage, setLivePage] = useState(1)
  const [videoSort, setVideoSort] = useState('revenue')
  const [tiktokProfile, setTiktokProfile] = useState<TikTokProfile | null>(null)
  const PAGE_SIZE = 10

  const range = getDateRange(days)

  const loadProfile = useCallback(async () => {
    setLoadingProfile(true)
    try {
      const data = await fetchCreatorDetail(creatorId, range)
      setProfile(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingProfile(false)
    }
  }, [creatorId, days])

  const loadContent = useCallback(async () => {
    setLoadingContent(true)
    setError(null)
    try {
      if (subTab === 'videos') {
        const data = await fetchCreatorVideos(creatorId, range, videoPage, PAGE_SIZE, videoSort)
        setVideos(Array.isArray(data) ? data : [])
      } else {
        const data = await fetchCreatorLives(creatorId, range, livePage, PAGE_SIZE)
        setLives(Array.isArray(data) ? data : [])
      }
    } catch (e: any) {
      const msg = e.message || 'Erro desconhecido'
      if (msg.includes('DATE_SPACING') || msg.includes('exceeds span')) {
        setError(`Periodo de ${days} dias nao permitido no plano atual.`)
      } else if (msg.includes('DATE_RANGE') || msg.includes('time range')) {
        setError(`Periodo fora do intervalo disponivel.`)
      } else {
        setError(msg)
      }
    } finally {
      setLoadingContent(false)
    }
  }, [creatorId, days, subTab, videoPage, livePage, videoSort])

  useEffect(() => { loadProfile() }, [loadProfile])
  useEffect(() => { loadContent() }, [loadContent])
  useEffect(() => { setVideoPage(1); setLivePage(1) }, [days, subTab])

  useEffect(() => {
    const h = creatorHandle || profile?.handle
    if (h) fetchTikTokProfile(h).then(setTiktokProfile)
  }, [creatorHandle, profile?.handle])

  const initial = (profile?.nickname || creatorHandle || creatorNickname || '?')[0].toUpperCase()
  const name = profile?.nickname || creatorNickname || creatorHandle || 'Criador'
  const handle = profile?.handle || creatorHandle || ''
  const tiktokUrl = handle ? `https://www.tiktok.com/@${handle}` : '#'

  // Compute summary stats from videos
  const videoStats = (() => {
    if (!videos.length) return null
    let totalRevenue = 0
    let totalSales = 0
    let count = 0

    for (const v of videos) {
      count++
      // Parse revenue string like "R$124,45k" to number
      if (v.gpm) totalRevenue += v.gpm
      if (typeof v.sale === 'number') totalSales += v.sale
      else if (typeof v.sale === 'string') {
        const n = parseFloat(v.sale.replace(/[^\d,.]/g, '').replace(',', '.'))
        if (!isNaN(n)) {
          if (v.sale.includes('k')) totalSales += n * 1000
          else if (v.sale.includes('m')) totalSales += n * 1000000
          else totalSales += n
        }
      }
    }

    return { count, totalSales: Math.round(totalSales) }
  })()

  const currentData = subTab === 'videos' ? videos : lives
  const currentPage = subTab === 'videos' ? videoPage : livePage
  const setCurrentPage = subTab === 'videos' ? setVideoPage : setLivePage

  return (
    <div className="creator-detail">
      {/* BACK HEADER */}
      <div className="cd-back-bar">
        <button className="cd-back-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Voltar para Criadores
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

      {/* PROFILE HEADER */}
      <div className="cd-profile">
        <div className="cd-profile-left">
          <div className="cd-avatar">
            {tiktokProfile?.url ? (
              <img src={tiktokProfile.url} alt={name} className="cd-avatar-img" onError={() => setTiktokProfile(p => p ? { ...p, url: undefined } : null)} />
            ) : (
              initial
            )}
          </div>
          <div className="cd-profile-info">
            <h2 className="cd-name">{name}</h2>
            {handle && <span className="cd-handle">@{handle}</span>}
            {profile?.signature && (
              <p className="cd-bio">{profile.signature}</p>
            )}
            {tiktokProfile?.bioLink && (
              <a className="cd-bio-link" href={tiktokProfile.bioLink} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={11} /> {tiktokProfile.bioLink}
              </a>
            )}
            <div className="cd-meta-tags">
              {profile?.creator_type && (
                <span className="card-tag tag-accent">{profile.creator_type === 'INDEPENDENT' ? 'Independente' : profile.creator_type}</span>
              )}
              {profile?.creatorDebut && (
                <span className="card-tag tag-blue">
                  <Calendar size={10} /> Desde {profile.creatorDebut}
                </span>
              )}
              {profile?.mcn_name && (
                <span className="card-tag tag-pink">{profile.mcn_name}</span>
              )}
            </div>
          </div>
        </div>
        <div className="cd-profile-right">
          <a className="cd-tiktok-btn" href={tiktokUrl} target="_blank" rel="noopener noreferrer">
            Perfil TikTok <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* STATS OVERVIEW */}
      <div className="cd-stats-grid">
        <div className="cd-stat-card">
          <div className="cd-stat-icon blue"><Users size={18} /></div>
          <div>
            <span className="cd-stat-label">Seguidores</span>
            <span className="cd-stat-value">
              {tiktokProfile?.followerCount
                ? formatNumber(tiktokProfile.followerCount)
                : profile?.follower_count || '-'}
            </span>
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon pink"><Heart size={18} /></div>
          <div>
            <span className="cd-stat-label">Curtidas</span>
            <span className="cd-stat-value">
              {tiktokProfile?.heartCount ? formatNumber(tiktokProfile.heartCount) : '-'}
            </span>
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon orange"><ShoppingBag size={18} /></div>
          <div>
            <span className="cd-stat-label">Produtos</span>
            <span className="cd-stat-value">{profile?.product_count || '-'}</span>
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon accent"><Video size={18} /></div>
          <div>
            <span className="cd-stat-label">Videos Total</span>
            <span className="cd-stat-value">
              {tiktokProfile?.videoCount
                ? tiktokProfile.videoCount.toLocaleString('pt-BR')
                : '-'}
            </span>
          </div>
        </div>
        <div className="cd-stat-card">
          <div className="cd-stat-icon green"><TrendingUp size={18} /></div>
          <div>
            <span className="cd-stat-label">Vendas (Periodo)</span>
            <span className="cd-stat-value">{videoStats ? videoStats.totalSales.toLocaleString('pt-BR') : '-'}</span>
          </div>
        </div>
      </div>

      {/* CONTACT INFO */}
      {profile && hasContactInfo(profile) && (
        <div className="cd-contact-section">
          <h3 className="cd-section-title">Contato</h3>
          <div className="cd-contact-grid">
            {getContact(profile, 'email') && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">Email</span>
                <span className="cd-contact-value">{getContact(profile, 'email')}</span>
              </div>
            )}
            {getContact(profile, 'whatsapp') && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">WhatsApp</span>
                <span className="cd-contact-value">{getContact(profile, 'whatsapp')}</span>
              </div>
            )}
            {getContact(profile, 'ins_id') && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">Instagram</span>
                <span className="cd-contact-value">{getContact(profile, 'ins_id')}</span>
              </div>
            )}
            {(getContact(profile, 'youtube_channel_title') || profile.youtube_channel_title) && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">YouTube</span>
                <span className="cd-contact-value">{getContact(profile, 'youtube_channel_title') || profile.youtube_channel_title}</span>
              </div>
            )}
            {getContact(profile, 'facebook') && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">Facebook</span>
                <span className="cd-contact-value">{getContact(profile, 'facebook')}</span>
              </div>
            )}
            {(getContact(profile, 'twitter_name') || profile.twitter_name) && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">Twitter/X</span>
                <span className="cd-contact-value">{getContact(profile, 'twitter_name') || profile.twitter_name}</span>
              </div>
            )}
            {getContact(profile, 'personal_homepage') && (
              <div className="cd-contact-item">
                <span className="cd-contact-label">Site</span>
                <a className="cd-contact-value cd-contact-link" href={getContact(profile, 'personal_homepage')!} target="_blank" rel="noopener noreferrer">
                  {getContact(profile, 'personal_homepage')}
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUB TABS */}
      <div className="cd-sub-tabs">
        <button
          className={`cd-sub-tab ${subTab === 'videos' ? 'active' : ''}`}
          onClick={() => setSubTab('videos')}
        >
          <Video size={14} /> Videos
        </button>
        <button
          className={`cd-sub-tab ${subTab === 'lives' ? 'active' : ''}`}
          onClick={() => setSubTab('lives')}
        >
          <Megaphone size={14} /> Lives
        </button>

        {subTab === 'videos' && (
          <div className="cd-sort-group">
            <span className="cd-sort-label">Ordenar:</span>
            {[
              { key: 'revenue', label: 'Receita' },
              { key: 'views', label: 'Views' },
              { key: 'sale', label: 'Vendas' },
            ].map(s => (
              <button
                key={s.key}
                className={`cd-sort-btn ${videoSort === s.key ? 'active' : ''}`}
                onClick={() => { setVideoSort(s.key); setVideoPage(1) }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <span className="cd-date-range">{range.startDate} → {range.endDate}</span>
      </div>

      {/* CONTENT */}
      <div className="cd-content">
        {loadingContent && (
          <div className="state-msg">
            <RefreshCw size={24} className="spin" />
            <span>Carregando...</span>
          </div>
        )}

        {error && !loadingContent && (
          <div className="state-msg error">
            <span>{error}</span>
          </div>
        )}

        {!loadingContent && !error && subTab === 'videos' && (
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
                    <th>Ads</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v, i) => (
                    <tr key={v.id || i}>
                      <td className="cd-td-rank">{(videoPage - 1) * PAGE_SIZE + i + 1}</td>
                      <td className="cd-td-desc">
                        <span className="cd-video-title">{v.description || 'Sem titulo'}</span>
                        {v.duration && <span className="cd-video-duration">{v.duration}</span>}
                      </td>
                      <td className="cd-td-revenue">{v.revenue || '-'}</td>
                      <td className="cd-td-sales">{typeof v.sale === 'number' ? v.sale.toLocaleString('pt-BR') : v.sale || '-'}</td>
                      <td className="cd-td-views">{v.views || '-'}</td>
                      <td className="cd-td-gpm">
                        {typeof v.gpm === 'number'
                          ? `R$${v.gpm.toFixed(2)}`
                          : v.gpm || '-'}
                      </td>
                      <td className="cd-td-ads">
                        {v.ad ? (
                          <span className="cd-ad-badge">
                            <Megaphone size={10} />
                            {v.ad_revenue_ratio && <span>{v.ad_revenue_ratio}</span>}
                          </span>
                        ) : (
                          <span className="cd-organic-badge">Organico</span>
                        )}
                      </td>
                      <td className="cd-td-date">{v.create_time ? formatDate(v.create_time) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {!loadingContent && !error && subTab === 'lives' && (
          <div className="cd-table-wrap">
            {lives.length === 0 ? (
              <div className="state-msg">Nenhuma live encontrada no periodo.</div>
            ) : (
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Live</th>
                    <th>Receita</th>
                    <th>Vendas</th>
                    <th>Views</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {lives.map((l, i) => (
                    <tr key={l.id || i}>
                      <td className="cd-td-rank">{(livePage - 1) * PAGE_SIZE + i + 1}</td>
                      <td className="cd-td-desc">{l.title || l.description || 'Live'}</td>
                      <td className="cd-td-revenue">{l.revenue || '-'}</td>
                      <td className="cd-td-sales">{l.sale?.toLocaleString('pt-BR') ?? '-'}</td>
                      <td className="cd-td-views">{l.views || '-'}</td>
                      <td className="cd-td-date">{l.create_time || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* PAGINATION */}
      {currentData.length > 0 && !loadingContent && (
        <div className="pagination">
          <button
            className="page-btn"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(p => p - 1)}
          >
            <ChevronLeft size={16} /> Anterior
          </button>
          <span className="page-info">Pagina {currentPage}</span>
          <button
            className="page-btn"
            disabled={currentData.length < PAGE_SIZE}
            onClick={() => setCurrentPage(p => p + 1)}
          >
            Proxima <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

function getContact(profile: any, field: string): string | null {
  const val = profile?.creatorContent?.[field] || profile?.[field]
  return val || null
}

function hasContactInfo(profile: any): boolean {
  const fields = ['email', 'whatsapp', 'ins_id', 'youtube_channel_title', 'facebook', 'twitter_name', 'personal_homepage']
  return fields.some(f => getContact(profile, f))
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace('.0', '') + 'k'
  return n.toLocaleString('pt-BR')
}

function formatDate(dateStr: string): string {
  // "2026/02/07 18:22:08" -> "07/02/2026"
  const parts = dateStr.split(' ')[0]?.split('/')
  if (parts?.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`
  return dateStr
}
