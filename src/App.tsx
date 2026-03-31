import { useState, useEffect, useCallback } from 'react'
import {
  ShoppingBag, Video, Users, TrendingUp, RefreshCw,
  Clock, ChevronLeft, ChevronRight, AlertTriangle, Wifi, WifiOff,
} from 'lucide-react'
import ProductCard from './components/ProductCard'
import VideoCard from './components/VideoCard'
import CreatorCard from './components/CreatorCard'
import {
  fetchProducts, fetchVideos, fetchHotVideos, fetchCreators,
  checkSession, getDateRange, type DateRange,
} from './lib/kalodata'
import './App.css'

type Tab = 'products' | 'hot-videos' | 'videos' | 'creators'

const DATE_OPTIONS = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
]

const PAGE_SIZE = 20

export default function App() {
  const [tab, setTab] = useState<Tab>('products')
  const [days, setDays] = useState(7)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionOk, setSessionOk] = useState<boolean | null>(null)

  // Check session on mount
  useEffect(() => {
    checkSession().then(setSessionOk)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const range = getDateRange(days)
      let result: any

      switch (tab) {
        case 'products':
          result = await fetchProducts(range, page, PAGE_SIZE)
          break
        case 'hot-videos':
          result = await fetchHotVideos(page, PAGE_SIZE)
          break
        case 'videos':
          result = await fetchVideos(range, page, PAGE_SIZE)
          break
        case 'creators':
          result = await fetchCreators(range, page, 10)
          break
      }

      setData(Array.isArray(result) ? result : [])
    } catch (e: any) {
      const msg = e.message || 'Erro desconhecido'
      if (msg.includes('DATE_SPACING') || msg.includes('exceeds span')) {
        setError(`Período de ${days} dias não permitido no plano atual. Tente um período menor.`)
      } else if (msg.includes('DATE_RANGE') || msg.includes('time range')) {
        setError(`Período fora do intervalo disponível. Tente um período menor.`)
      } else {
        setError(msg)
      }
      setData([])
    } finally {
      setLoading(false)
    }
  }, [tab, days, page])

  useEffect(() => { load() }, [load])

  // Reset page when tab or days change
  useEffect(() => { setPage(1) }, [tab, days])

  const tabs: { key: Tab; label: string; icon: any }[] = [
    { key: 'products', label: 'Produtos Top', icon: ShoppingBag },
    { key: 'hot-videos', label: 'Vídeos em Alta', icon: TrendingUp },
    { key: 'videos', label: 'Vídeos que Vendem', icon: Video },
    { key: 'creators', label: 'Criadores', icon: Users },
  ]

  const range = getDateRange(days)
  const showDateFilter = tab !== 'hot-videos'
  const showPagination = data.length >= PAGE_SIZE || page > 1

  return (
    <div className="app">
      {/* HEADER */}
      <header className="header">
        <div className="header-left">
          <div className="logo"><TrendingUp size={20} /></div>
          <div>
            <h1 className="header-title">Kalodata Dashboard</h1>
            <p className="header-sub">TikTok Shop Brasil — Dados em tempo real</p>
          </div>
        </div>
        <div className="header-right">
          <div className="session-status">
            {sessionOk === null ? (
              <span className="status-dot loading" />
            ) : sessionOk ? (
              <><Wifi size={13} /> <span className="status-ok">Conectado</span></>
            ) : (
              <><WifiOff size={13} /> <span className="status-err">Sessão expirada</span></>
            )}
          </div>
          <button className="btn-refresh" onClick={load} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {/* TABS */}
      <nav className="tabs">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <t.icon size={16} />
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* FILTERS */}
      <div className="filters-bar">
        {showDateFilter && (
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
        )}
        <div className="filter-info">
          {showDateFilter && (
            <span className="filter-range">{range.startDate} → {range.endDate}</span>
          )}
          {!showDateFilter && (
            <span className="filter-range">Trending agora</span>
          )}
        </div>
      </div>

      {/* CONTENT */}
      <main className="main">
        {loading && (
          <div className="state-msg">
            <RefreshCw size={24} className="spin" />
            <span>Carregando...</span>
          </div>
        )}

        {error && (
          <div className="state-msg error">
            <AlertTriangle size={20} />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <>
            {tab === 'products' && (
              <div className="grid products-grid">
                {data.map((p, i) => (
                  <ProductCard key={p.id || i} product={p} rank={(page - 1) * PAGE_SIZE + i + 1} />
                ))}
              </div>
            )}

            {tab === 'hot-videos' && (
              <div className="grid videos-grid">
                {data.map((v, i) => (
                  <VideoCard key={v.video_id || i} video={v} rank={(page - 1) * PAGE_SIZE + i + 1} type="hot" />
                ))}
              </div>
            )}

            {tab === 'videos' && (
              <div className="grid videos-grid">
                {data.map((v, i) => (
                  <VideoCard key={v.id || i} video={v} rank={(page - 1) * PAGE_SIZE + i + 1} type="selling" />
                ))}
              </div>
            )}

            {tab === 'creators' && (
              <div className="grid creators-grid">
                {data.map((c, i) => (
                  <CreatorCard key={c.id || i} creator={c} rank={(page - 1) * 10 + i + 1} />
                ))}
              </div>
            )}

            {data.length === 0 && !loading && (
              <div className="state-msg">Nenhum resultado encontrado.</div>
            )}
          </>
        )}
      </main>

      {/* PAGINATION */}
      {showPagination && !loading && !error && (
        <div className="pagination">
          <button
            className="page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            <ChevronLeft size={16} /> Anterior
          </button>
          <span className="page-info">Página {page}</span>
          <button
            className="page-btn"
            disabled={data.length < PAGE_SIZE}
            onClick={() => setPage(p => p + 1)}
          >
            Próxima <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
