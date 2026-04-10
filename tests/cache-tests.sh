#!/bin/bash
# Cache behavior tests for Cloudflare Worker
# Tests that edge cache serves results for repeat requests
# and that no new upstream calls are made for cached results.
#
# Usage: bash tests/cache-tests.sh [staging|prod]

set -e

ENV="${1:-staging}"
if [ "$ENV" = "prod" ]; then
  WORKER="https://cors-proxy.sahit-koganti.workers.dev"
else
  WORKER="https://cors-proxy-staging.sahit-koganti.workers.dev"
fi

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

echo "=== Cache Tests (${ENV}) ==="
echo "Worker: ${WORKER}"
echo ""

# ─────────────────────────────────────────────
# Test 1: YouTube edge cache — second request is HIT
# ─────────────────────────────────────────────
echo "--- Test 1: YouTube edge cache ---"
UNIQUE_Q="cache-test-yt-$(date +%s)"

# First request — should be MISS (fresh query never seen before)
RESP1=$(curl -s -D - "$WORKER/youtube/search?q=${UNIQUE_Q}&maxResults=1" 2>&1)
CACHE1=$(echo "$RESP1" | grep -i "x-cache:" | tr -d '\r' | awk '{print $2}')
STATUS1=$(echo "$RESP1" | head -1 | awk '{print $2}')

if [ "$STATUS1" = "200" ]; then
  if [ "$CACHE1" = "MISS" ]; then
    pass "First YouTube request is MISS"
  else
    # Could be HIT if this exact query was somehow cached before
    skip "First YouTube request returned X-Cache: ${CACHE1} (expected MISS, may be pre-cached)"
  fi
else
  fail "First YouTube request returned HTTP ${STATUS1} (expected 200)"
fi

# Second request — same query, should be HIT
RESP2=$(curl -s -D - "$WORKER/youtube/search?q=${UNIQUE_Q}&maxResults=1" 2>&1)
CACHE2=$(echo "$RESP2" | grep -i "x-cache:" | tr -d '\r' | awk '{print $2}')
STATUS2=$(echo "$RESP2" | head -1 | awk '{print $2}')

if [ "$STATUS2" = "200" ]; then
  if [ "$CACHE2" = "HIT" ]; then
    pass "Second YouTube request is HIT (served from edge cache)"
  else
    fail "Second YouTube request returned X-Cache: ${CACHE2} (expected HIT)"
  fi
else
  fail "Second YouTube request returned HTTP ${STATUS2} (expected 200)"
fi

# Verify both responses return the same data
BODY1=$(echo "$RESP1" | sed '1,/^\r$/d')
BODY2=$(echo "$RESP2" | sed '1,/^\r$/d')
if [ "$BODY1" = "$BODY2" ]; then
  pass "Cached response body matches original"
else
  fail "Cached response body differs from original"
fi

echo ""

# ─────────────────────────────────────────────
# Test 2: News edge cache — second request is HIT
# ─────────────────────────────────────────────
echo "--- Test 2: News edge cache ---"
NEWS_Q="Andhra+Pradesh+capital+$(date +%s)"

RESP3=$(curl -s -D - "$WORKER/news/search?q=${NEWS_Q}&maxResults=2" 2>&1)
CACHE3=$(echo "$RESP3" | grep -i "x-cache:" | tr -d '\r' | awk '{print $2}')
STATUS3=$(echo "$RESP3" | head -1 | awk '{print $2}')

if [ "$STATUS3" = "200" ]; then
  if [ "$CACHE3" = "MISS" ]; then
    pass "First News request is MISS"
  else
    skip "First News request returned X-Cache: ${CACHE3}"
  fi
else
  # News may 502 if Google blocks — skip rather than fail
  skip "News request returned HTTP ${STATUS3} (Google may be blocking)"
fi

if [ "$STATUS3" = "200" ]; then
  RESP4=$(curl -s -D - "$WORKER/news/search?q=${NEWS_Q}&maxResults=2" 2>&1)
  CACHE4=$(echo "$RESP4" | grep -i "x-cache:" | tr -d '\r' | awk '{print $2}')

  if [ "$CACHE4" = "HIT" ]; then
    pass "Second News request is HIT (served from edge cache)"
  else
    fail "Second News request returned X-Cache: ${CACHE4} (expected HIT)"
  fi

  BODY3=$(echo "$RESP3" | sed '1,/^\r$/d')
  BODY4=$(echo "$RESP4" | sed '1,/^\r$/d')
  if [ "$BODY3" = "$BODY4" ]; then
    pass "Cached news response body matches original"
  else
    fail "Cached news response body differs from original"
  fi
fi

echo ""

# ─────────────────────────────────────────────
# Test 3: Different queries get different results (no cross-contamination)
# ─────────────────────────────────────────────
echo "--- Test 3: Cache isolation ---"
Q_A="Amaravati+Secretariat+$(date +%s)"
Q_B="Vijayawada+expressway+$(date +%s)"

RESP_A=$(curl -s "$WORKER/youtube/search?q=${Q_A}&maxResults=1" 2>&1)
RESP_B=$(curl -s "$WORKER/youtube/search?q=${Q_B}&maxResults=1" 2>&1)

if [ "$RESP_A" != "$RESP_B" ]; then
  pass "Different queries return different results (no cross-contamination)"
else
  # Could legitimately be the same if both return empty or same top result
  skip "Both queries returned identical results (may be coincidence)"
fi

echo ""

# ─────────────────────────────────────────────
# Test 4: Cache-Control header is set correctly
# ─────────────────────────────────────────────
echo "--- Test 4: Cache-Control headers ---"
CC_YT=$(curl -s -D - "$WORKER/youtube/search?q=Amaravati&maxResults=1" 2>&1 | grep -i "cache-control:" | tr -d '\r')
CC_NEWS=$(curl -s -D - "$WORKER/news/search?q=Andhra+Pradesh&maxResults=1" 2>&1 | grep -i "cache-control:" | tr -d '\r')

if echo "$CC_YT" | grep -q "max-age=21600"; then
  pass "YouTube Cache-Control has max-age=21600 (6 hours)"
else
  fail "YouTube Cache-Control: ${CC_YT} (expected max-age=21600)"
fi

if echo "$CC_NEWS" | grep -q "max-age=21600"; then
  pass "News Cache-Control has max-age=21600 (6 hours)"
else
  # News might have failed with 502
  if echo "$CC_NEWS" | grep -qi "cache-control"; then
    fail "News Cache-Control: ${CC_NEWS} (expected max-age=21600)"
  else
    skip "News request may have failed (no Cache-Control header)"
  fi
fi

echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "=== Results ==="
echo "  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
