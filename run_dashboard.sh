#!/usr/bin/env bash
# DrillDash launcher: builds the data store on first run, then starts the dashboard.
cd "$(dirname "$0")" || exit 1

# Python to use, in order of preference:
#   1. $PY if set, e.g.  PY=/path/to/python ./run_dashboard.sh
#   2. the currently activated conda env or venv
#   3. a base Anaconda/Miniconda install, then python3 on the PATH
if [ -z "$PY" ]; then
  for candidate in "$CONDA_PREFIX/bin/python" "$VIRTUAL_ENV/bin/python" \
                   "$HOME/anaconda3/bin/python" "$HOME/miniconda3/bin/python" \
                   "/opt/anaconda3/bin/python" "/opt/miniconda3/bin/python"; do
    if [ -x "$candidate" ]; then PY="$candidate"; break; fi
  done
fi
[ -n "$PY" ] || PY=python3
echo "Using Python: $PY"

if ! "$PY" -c "import pandas, numpy, pyarrow, flask" >/dev/null 2>&1; then
  echo "Missing Python packages for $PY. Install them with:"
  echo "  \"$PY\" -m pip install pandas numpy pyarrow flask"
  exit 1
fi

# builds the store on first run if the Volve data is present; otherwise the server shows the bundled demo wells
if ! "$PY" -W ignore ingest.py --auto; then
  echo "Ingest failed. See messages above."
  exit 1
fi

echo "Starting DrillDash at http://localhost:8050  (press Ctrl+C to stop)"
"$PY" server.py
