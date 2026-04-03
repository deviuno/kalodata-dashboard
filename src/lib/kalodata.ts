async function post<T = any>(path: string, body: Record<string, any>): Promise<T> {
  const res = await fetch(`/api/kalo/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 'BR', ...body }),
  })
  const json = await res.json()
  if (!json.success) {
    throw new Error(json.message || 'API error')
  }
  return json.data
}

export interface DateRange {
  startDate: string
  endDate: string
}

export function getDateRange(days: number): DateRange {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  return {
    startDate: fmt(start),
    endDate: fmt(end),
  }
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0]
}

export async function fetchProducts(
  range: DateRange,
  pageNo = 1,
  pageSize = 20,
  sortField = 'revenue',
) {
  return post('product/queryList', {
    ...range,
    pageNo,
    pageSize,
    cateIds: [],
    showCateIds: [],
    sort: [{ field: sortField, type: 'DESC' }],
  })
}

export async function fetchVideos(
  range: DateRange,
  pageNo = 1,
  pageSize = 20,
  sortField = 'revenue',
) {
  return post('video/queryList', {
    ...range,
    pageNo,
    pageSize,
    cateIds: [],
    showCateIds: [],
    sort: [{ field: sortField, type: 'DESC' }],
  })
}

export async function fetchHotVideos(pageNo = 1, pageSize = 20) {
  return post('homepage/hot/video/queryList', {
    pageIndex: pageNo,
    pageSize,
  })
}

export async function fetchCreators(
  range: DateRange,
  pageNo = 1,
  pageSize = 10,
  sortField = 'revenue',
) {
  return post('creator/queryList', {
    ...range,
    pageNo,
    pageSize,
    cateIds: [],
    showCateIds: [],
    sort: [{ field: sortField, type: 'DESC' }],
  })
}

export async function fetchCreatorDetail(
  id: string,
  range: DateRange,
) {
  return post('creator/detail', {
    id,
    ...range,
  })
}

export async function fetchCreatorVideos(
  id: string,
  range: DateRange,
  pageNo = 1,
  pageSize = 10,
  sortField = 'revenue',
) {
  return post('creator/detail/video/queryList', {
    id,
    ...range,
    pageNo,
    pageSize,
    sort: [{ field: sortField, type: 'DESC' }],
  })
}

export async function fetchCreatorLives(
  id: string,
  range: DateRange,
  pageNo = 1,
  pageSize = 10,
  sortField = 'revenue',
) {
  return post('creator/detail/live/queryList', {
    id,
    ...range,
    pageNo,
    pageSize,
    sort: [{ field: sortField, type: 'DESC' }],
  })
}

export interface TikTokProfile {
  url?: string
  bioLink?: string
  followingCount?: number
  followerCount?: number
  heartCount?: number
  videoCount?: number
}

export async function fetchTikTokProfile(handle: string): Promise<TikTokProfile | null> {
  try {
    const res = await fetch(`/api/creator/${encodeURIComponent(handle)}/avatar`)
    const json = await res.json()
    return json.success ? json.data : null
  } catch {
    return null
  }
}

export interface CreatorSearchResult {
  userId: string
  handle: string
  nickname?: string
  signature?: string
  url?: string
  bioLink?: string
  followingCount?: number
  followerCount?: number
  heartCount?: number
  videoCount?: number
}

export async function searchCreatorByHandle(handle: string): Promise<CreatorSearchResult | null> {
  try {
    const res = await fetch(`/api/creator/search/${encodeURIComponent(handle)}`)
    const json = await res.json()
    return json.success ? json.data : null
  } catch {
    return null
  }
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/kalo/user/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: 'BR', list: ['PRODUCT.LIST'] }),
    })
    const json = await res.json()
    return json.success === true
  } catch {
    return false
  }
}
