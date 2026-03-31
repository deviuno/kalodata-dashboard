#!/usr/bin/env bash
# Kalodata Data Fetcher
# Usage: ./scripts/kalodata-fetch.sh
# Requires: cookies.txt in project root (copy Cookie header from browser DevTools)
# Cookies last ~15 days before needing renewal.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/public/data"
COOKIES_FILE="$PROJECT_DIR/cookies.txt"

UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

if [[ -n "${KALODATA_COOKIES:-}" ]]; then
  COOKIES="$KALODATA_COOKIES"
elif [[ -f "$COOKIES_FILE" ]]; then
  COOKIES="$(cat "$COOKIES_FILE")"
else
  echo "ERROR: No cookies found. Create cookies.txt with your browser Cookie header." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

kalo_post() {
  local url="$1"
  local data="$2"
  curl -s --max-time 30 -A "$UA" -b "$COOKIES" \
    -H 'content-type: application/json' \
    -H 'country: BR' -H 'currency: BRL' -H 'language: pt-BR' \
    -H 'origin: https://www.kalodata.com' \
    -H 'referer: https://www.kalodata.com/explore' \
    -X POST "https://www.kalodata.com${url}" \
    --data-raw "$data"
}

echo "[$(date)] Fetching Kalodata data..."

# Check session
SESSION_CHECK=$(kalo_post "/user/features" '{"country":"BR","list":["PRODUCT.LIST"]}')
if echo "$SESSION_CHECK" | grep -q '"success":false'; then
  echo "ERROR: Session expired. Update cookies.txt" >&2
  exit 1
fi
echo "  Session OK"

# Top 20 products (yesterday)
echo "  Fetching top 20 products..."
kalo_post "/product/queryList" \
  "{\"country\":\"BR\",\"pageIndex\":1,\"pageSize\":20,\"sortColumn\":\"revenue\",\"sortDirection\":\"desc\",\"startDate\":\"$YESTERDAY\",\"endDate\":\"$YESTERDAY\"}" \
  > "$DATA_DIR/products.json"

# Hot videos (trending, no date needed)
echo "  Fetching top 20 hot videos..."
kalo_post "/homepage/hot/video/queryList" \
  '{"country":"BR","pageIndex":1,"pageSize":20}' \
  > "$DATA_DIR/hot-videos.json"

# Top selling videos (yesterday)
echo "  Fetching top 20 selling videos..."
kalo_post "/video/queryList" \
  "{\"country\":\"BR\",\"pageIndex\":1,\"pageSize\":20,\"sortColumn\":\"revenue\",\"sortDirection\":\"desc\",\"startDate\":\"$YESTERDAY\",\"endDate\":\"$YESTERDAY\"}" \
  > "$DATA_DIR/videos.json"

# Top creators (limit 10 on basic plan)
echo "  Fetching top 10 creators..."
kalo_post "/creator/queryList" \
  "{\"country\":\"BR\",\"pageIndex\":1,\"pageSize\":10,\"sortColumn\":\"revenue\",\"sortDirection\":\"desc\",\"startDate\":\"$YESTERDAY\",\"endDate\":\"$YESTERDAY\"}" \
  > "$DATA_DIR/creators.json"

# Metadata
cat > "$DATA_DIR/meta.json" <<EOF
{"fetchedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","date":"$YESTERDAY","today":"$TODAY"}
EOF

echo "[$(date)] Done! Data saved to public/data/"
