# Dynasty Dashboard

An interactive dashboard for Herbert's Wangs, using Sleeper league `1312004884693807104`.

Run `python serve.py` in this folder and open `http://127.0.0.1:8765/` to preview the dashboard. **Sync Data** runs the same snapshot builder as GitHub Actions using Python in a browser worker. The worker fetches data directly from Sleeper and displays the result in the current tab. GitHub Actions publishes the site files and the three shared snapshots under `data/`.

Run `python build.py` with Python 3.11 or newer and internet access to refresh the snapshots in `data/`. `sleeper.json` contains league data, matchup scores, and NFL game status. `projections.json` contains RotoWire projection records delivered by Sleeper. `lineups.json` contains starters for each team in Weeks 1–14. The build uses Sleeper’s actual starters through the current week and fills future lineups from the latest weekly projections.

To share a refresh, commit the generated JSON files together and publish them with the dashboard.

`index.html` is the page structure and navigation. `styles.css` controls its appearance, and `dashboard.js` loads the data, renders tabs, and runs the simulations. The hidden Trade Values tab uses `ktc_snapshot.json` when enabled. `fit_variance.py` is the separate research script used to fit the median forecast's variance curves.

The build follows the original league's linked successor seasons when they appear in the configured Sleeper user's league list. Future picks are estimated for the next three drafts using the current number of rounds and traded picks returned by Sleeper.

The Teams view uses Sleeper's regular-season PPR totals and positional ranks. Average points are total PPR points divided by Sleeper's games played. The lineup fills fixed positions first, then FLEX and SUPERFLEX, using the highest available average in each slot. IR and taxi players appear on the bench.

