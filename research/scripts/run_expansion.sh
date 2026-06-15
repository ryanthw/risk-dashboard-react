#!/bin/bash
# Full universe expansion: pull -> analyze -> fetch (all resumable). Sequential,
# since each stage depends on the previous. Output is one combined log.
set -o pipefail
ROOT="/Users/ryanwalker/Documents/Micro-Fund Tech/Risk Dashboard React"
cd "$ROOT" || exit 1

echo "STAGE pull $(date +%H:%M:%S)"
python3 research/scripts/pull_extra.py research/data/new_tickers.txt || { echo "FATAL pull failed"; exit 1; }

echo "STAGE analyze $(date +%H:%M:%S)"
python3 research/scripts/analyze_moves.py 2>&1 | head -1 || { echo "FATAL analyze failed"; exit 1; }

echo "STAGE fetch $(date +%H:%M:%S)"
python3 research/scripts/fetch_options.py || { echo "FATAL fetch failed"; exit 1; }

echo "DONE_ALL $(date +%H:%M:%S)"
