import {loadPyodide} from 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.mjs';

try {
  const [python, source] = await Promise.all([loadPyodide(), fetch('./build.py', {cache:'no-cache'})]);
  if (!source.ok) throw Error(`Could not load build.py (HTTP ${source.status}).`);
  python.FS.writeFile('build.py', await source.text());
  const payload = await python.runPythonAsync(`
import asyncio
import json
from js import AbortSignal
from pyodide.http import pyfetch
from build import build_snapshots

async def sync_snapshots():
    request_slots = asyncio.Semaphore(6)

    async def fetch_json(path):
        async with request_slots:
            response = await pyfetch(
                f"https://api.sleeper.app/{path}",
                cache="no-store",
                signal=AbortSignal.timeout(30000),
            )
            response.raise_for_status()
            return await response.json()

    builder = build_snapshots()
    paths = next(builder)
    while True:
        responses = await asyncio.gather(*(fetch_json(path) for path in paths))
        try:
            paths = builder.send(responses)
        except StopIteration as complete:
            league, projections, lineups = complete.value
            return json.dumps({"league": league, "projections": projections, "lineups": lineups},
                              allow_nan=False, separators=(",", ":"))

await sync_snapshots()
`);
  postMessage({payload});
} catch (error) {
  postMessage({error: error.message});
}
