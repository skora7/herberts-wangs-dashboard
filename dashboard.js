const sessionSnapshotKey = 'dashboard-builder-snapshots-v1';
let dashboardEvents;

async function syncSleeper() {
  const worker = new Worker('./sync-worker.js', {type:'module'});
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(Error(data.error)) : resolve(data.payload);
      worker.onerror = () => reject(Error('Could not start the browser snapshot builder.'));
    });
  } finally {
    worker.terminate();
  }
}

async function publishedSnapshots() {
  const projectionRequest = fetch('./data/projections.json', {cache:'no-cache'})
    .then(response => response.ok ? response.json() : null)
    .catch(() => null);
  const lineupRequest = fetch('./data/lineups.json', {cache:'no-cache'})
    .then(response => response.ok ? response.json() : null)
    .catch(() => null);
  const response = await fetch('./data/sleeper.json', {cache:'no-cache'});
  if (!response.ok) throw Error('Could not load the published Sleeper snapshot.');
  const data = await response.json();
  return {league: data, projections: await projectionRequest, lineups: await lineupRequest};
}

async function startDashboard(snapshots, initialView) {
  const {league: data, projections: projectionSnapshot, lineups: lineupSnapshot} = snapshots;
  if (!document.querySelector('[data-view="values"]').hidden) {
    const ktcResponse = await fetch('./ktc_snapshot.json');
    if (ktcResponse.ok) data.ktc = await ktcResponse.json();
  }
  dashboardEvents?.abort();
  dashboardEvents = new AbortController();
  const {signal} = dashboardEvents;
  const listenerOptions = {signal};
  const content = document.querySelector('#content');
  const tabs = [...document.querySelectorAll('[data-view]')];
  const teams = new Map(data.teams.map(team => [team.id, team]));
  const name = id => teams.get(id)?.name ?? `Team ${id}`;
  const html = value => String(value).replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
  const teamButton = id => `<button class="team" data-team="${id}">${html(name(id))}</button>`;
  const points = (value, digits = 2) => value == null ? '—' : value.toLocaleString(undefined, {
    minimumFractionDigits:digits, maximumFractionDigits:digits
  });
  const record = team => `${team.wins}–${team.losses}${team.ties ? `–${team.ties}` : ''}`;
  const weeks = Object.keys(data.weeks).map(Number).sort((a, b) => b - a);
  const matchupWeeks = Array.from({length:14}, (_, index) => 14 - index);
  const currentWeek = data.currentWeek ?? weeks[0] ?? 1;
  const view = tabs.find(tab => !tab.hidden && tab.dataset.view === initialView)?.dataset.view ?? 'standings';
  const state = {view, sort:'record', direction:-1, week:Math.min(14, currentWeek), team:data.teams[0]?.id};
  const teamSections = ['Assets', 'Stats', 'Lineups'];
  state.teamSection = 'Assets';
  state.lineupWeek = state.week;
  document.title = `${data.name} · Dynasty Dashboard`;
  document.querySelector('#league').textContent = data.name;
  document.querySelector('#season').textContent = `${data.season} season · ${teams.size} teams`;
  document.querySelector('#updated').textContent = `Sleeper data last synced ${new Date(data.updated).toLocaleString()}`;

  function select(label, field, options, current) {
    return `<label>${label}<select data-field="${field}">${options.map(([value, text]) =>
      `<option value="${value}" ${String(value) === String(current) ? 'selected' : ''}>${html(text)}</option>`).join('')}</select></label>`;
  }

  function table(headers, rows) {
    return `<div class="table" tabindex="0"><table><thead><tr>${headers.join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }

  function simpleTable(headers, rows) {
    return table(headers.map(header => `<th scope="col">${header}</th>`), rows.map(row =>
      `<tr>${row.map(cell => `<td>${html(cell)}</td>`).join('')}</tr>`));
  }

  const teamOptions = [...teams.values()].sort((a,b) => a.name.localeCompare(b.name)).map(team => [team.id, team.name]);
  state.isolate = teamOptions[0]?.[0];
  const winRate = team => (team.wins + team.ties / 2) / (team.wins + team.losses + team.ties || 1);
  const standingsTiebreaker = (a, b) => b.pf - a.pf || a.name.localeCompare(b.name);
  const compareStandings = (a, b) => winRate(b) - winRate(a) || standingsTiebreaker(a, b);

  function standings() {
    const labels = {name:'Team', record:'Record', pf:'Points for', pa:'Points against'};
    const compare = (a, b) => {
      if (state.sort === 'name') return a.name.localeCompare(b.name);
      if (state.sort === 'record') return winRate(a) - winRate(b);
      return a[state.sort] - b[state.sort];
    };
    const sorted = [...teams.values()].sort((a,b) => state.direction * compare(a,b) || standingsTiebreaker(a,b));
    const headers = Object.entries(labels).map(([key, label]) => {
      const active = key === state.sort;
      const direction = state.direction === 1 ? 'ascending' : 'descending';
      return `<th scope="col"${active ? ` aria-sort="${direction}"` : ''}><button data-sort="${key}">${label}${active ? (state.direction === 1 ? ' ↑' : ' ↓') : ''}</button></th>`;
    });
    return `<div class="heading"><div><h2>Standings</h2><p>Sort any column or select a team to see its roster and picks.</p></div></div>
      ${table(headers, sorted.map(team => `<tr><td>${teamButton(team.id)}</td><td>${record(team)}</td><td>${points(team.pf)}</td><td>${points(team.pa)}</td></tr>`))}`;
  }

  function projectedLineupTotal(week, teamId) {
    const savedLineups = lineupSnapshot?.season === data.season ? lineupSnapshot.weeks?.[week] : null;
    const lineup = savedLineups?.source === 'projected' ? savedLineups.teams?.[teamId] : null;
    const occupied = lineup?.filter(slot => slot.playerId && slot.playerId !== '0');
    if (!lineup?.length || (occupied.length && !occupied.some(slot => Number.isFinite(slot.projectedPoints)))) {
      return null;
    }
    return occupied.reduce((sum, slot) => sum + (slot.projectedPoints ?? 0), 0);
  }

  const currentInputs = data.medianModel.inputs?.[currentWeek];
  const completedNflTeams = new Set((currentInputs?.schedule ?? [])
    .filter(game => Number(game.week) === currentWeek && game.status === 'complete')
    .flatMap(game => [game.home, game.away]));
  const finalizedTeams = new Set((currentInputs?.matchups ?? [])
    .filter(({starters}) => starters?.length === 9 && starters.every(id =>
      id && id !== '0' && completedNflTeams.has(data.medianModel.players[id]?.[0])))
    .map(matchup => matchup.roster_id));
  const scoreFinalized = (week, id) => week <= data.medianModel.lastScored ||
    (week === currentWeek && (data.currentWeekFinished || finalizedTeams.has(id)));

  function matchups() {
    const {week} = state;
    const future = week > currentWeek;
    const scheduled = data.playoffModel.schedule[week - data.medianModel.lastScored - 1];
    const games = data.weeks[week] ?? scheduled?.map(game => game.map(id => ({id, points:0}))) ?? [];
    const finalized = week <= data.medianModel.lastScored || (week === currentWeek && data.currentWeekFinished);
    const scores = games.flat().map(row => row.points).sort((a, b) => a - b);
    const middle = (scores.length - 1) / 2;
    const median = finalized && data.playoffModel.medianGame && week < data.medianModel.playoffStart &&
      scores.length > 0 && scores.length === teams.size && scores.every(Number.isFinite)
      ? (scores[Math.floor(middle)] + scores[Math.ceil(middle)]) / 2 : null;
    return `<div class="heading"><div><h2>Matchups</h2><p>Browse weekly scores by team.</p></div>
      <div class="filters">${select('Week','week', matchupWeeks.map(week => [week, `Week ${week}`]), state.week)}</div></div>
      ${games.length ? `<div class="cards">${games.map(game => `<article class="card">${game.map(row => {
        const opponent = game.length === 2 ? game.find(other => other.id !== row.id) : null;
        const headToHeadWin = finalized && Number.isFinite(row.points) &&
          Number.isFinite(opponent?.points) && row.points > opponent.points;
        const trophy = headToHeadWin ? '<span class="matchup-badge trophy" role="img" aria-label="Head-to-head win" title="Head-to-head win">🏆</span>' : '';
        const medianBadge = median !== null && row.points > median
          ? '<span class="matchup-badge median-badge" role="img" aria-label="Median win" title="Median win">M</span>' : '';
        const total = future ? projectedLineupTotal(week, row.id) : null;
        const provisional = week === currentWeek && !scoreFinalized(week, row.id);
        const score = future
          ? `<span class="matchup-points" title="${total == null ? 'Projection unavailable' : 'Projected score'}">${total == null ? points(null) : `~${points(total)}`}</span>`
          : provisional
          ? `<span class="matchup-points" title="Points from completed games so far">${points(row.points)}</span>`
          : `<strong class="matchup-points">${points(row.points)}</strong>`;
        return `<div class="result">${teamButton(row.id)}<div class="matchup-score${future || provisional ? ' projected-score' : ''}">${trophy}${medianBadge}${score}</div></div>`;
      }).join('')}</article>`).join('')}</div>`
        : '<p>No matchups available for this selection.</p>'}${medianPanel()}`;
  }

  // Fixed fits from fit_variance.py. Coefficients are in squared PPR points.
  const varianceCurves = {QB:[36.4098,1.5083], RB:[.6254,4.2599], WR:[6.8302,3.8625], TE:[2.4392,4.1774]};
  const medianTrialCount = 10_000;
  const medianForecasts = new Map();

  function medianPanel() {
    const model = data.medianModel;
    if (!model || state.week > currentWeek || state.week >= model.playoffStart || !data.playoffModel.medianGame) return '';
    const forecast = medianForecasts.get(state.week);
    const isolated = forecast?.results?.teams.get(Number(state.isolate));
    const metrics = isolated ? [
      [forecast.final ? 'Final 11-team median' : 'Projected 11-team median', points(isolated.median)],
      [forecast.final ? 'Final team score' : 'Projected team score', points(isolated.score)],
      ['Chance to beat median', `${points(isolated.win * 100, 1)}%`],
    ] : [];
    const formulas = Object.entries(varianceCurves).map(([position, [intercept, slope]]) =>
      `${position}: ${intercept.toFixed(4)} + ${slope.toFixed(4)}p`).join(' · ');
    return `<section class="analytics"><div class="heading"><div><h3>Median</h3>
      <p>Games in progress use full-game projections. Finished games use actual points.</p></div>
      <div class="filters">${select('Isolate a team', 'isolate', teamOptions, state.isolate)}
      <button data-run-median ${forecast?.loading ? 'disabled' : ''}>${forecast?.loading ? 'Loading…' : 'Run Monte Carlo'}</button></div></div>
      ${forecast?.message ? `<p role="status">${html(forecast.message)}</p>` : ''}
      ${metrics.length ? `<dl class="metrics">${metrics.map(([label, value]) =>
        `<div class="card"><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` : ''}
      <p>Forecasts use ${medianTrialCount.toLocaleString()} Monte Carlo trials with independent player scores.
      Ties count as half a win. Finished scores are evaluated directly.</p>
      <p>Variance in squared PPR points, fitted from historical projection errors. For a nonzero RotoWire pregame projection,
      <var>p</var> is the projected PPR score with a minimum input of 2. A zero projection has zero variance.</p>
      <p>${formulas}</p></section>`;
  }

  function sampleMedian(lineups) {
    const results = new Map(lineups.map(team => [team.id, {score:0, median:0, win:0}]));
    const trials = lineups.some(team => team.players.length) ? medianTrialCount : 1;
    for (let trial = 0; trial < trials; trial++) {
      const scores = lineups.map(team => {
        const score = team.players.reduce((total, player) => total + player.mean + player.sd * normalDraw(), team.fixed);
        return {id:team.id, score:Math.round(score * 100)};
      }).sort((a,b) => a.score - b.score);
      const middle = scores.length / 2;
      scores.forEach(({id, score}, index) => {
        const otherMedian = scores[index < middle ? middle : middle - 1].score;
        const result = results.get(id);
        result.score += score;
        result.median += otherMedian;
        result.win += score === otherMedian ? .5 : Number(score > otherMedian);
      });
    }
    for (const result of results.values()) {
      result.score /= 100 * trials;
      result.median /= 100 * trials;
      result.win /= trials;
    }
    return {teams:results};
  }

  function loadMedian(week) {
    const {inputs, lastScored, players} = data.medianModel;
    const validate = lineups => {
      const ids = new Set(lineups.map(team => team.id));
      if (lineups.length !== teams.size || ids.size !== teams.size || ids.size % 2 ||
          [...ids].some(id => !teams.has(id)) || lineups.some(team => !Number.isFinite(team.fixed))) {
        throw Error('Complete scores for an even number of league teams are required.');
      }
      return lineups;
    };
    if (week <= lastScored) {
      const lineups = (data.weeks[week] ?? []).flat().map(row => ({id:row.id, fixed:row.points, players:[]}));
      return {results:sampleMedian(validate(lineups)), final:true};
    }
    const snapshot = inputs?.[week];
    if (!snapshot) throw Error('Median inputs are unavailable for this week in the published snapshot.');
    const {matchups, schedule} = snapshot;
    const games = new Map(schedule.filter(game => Number(game.week) === week).map(game => [String(game.game_id), game]));
    if (!games.size) throw Error('The NFL schedule is unavailable for this week.');
    const final = [...games.values()].every(game => game.status === 'complete');
    const projections = projectionSnapshot?.season === data.season ? projectionSnapshot.weeks?.[week] : null;
    if (!final && !Array.isArray(projections)) {
      throw Error('RotoWire projections are unavailable for this week in the published snapshot.');
    }
    const gameByTeam = new Map([...games.values()].flatMap(game => [[game.home,game], [game.away,game]]));
    const projectionByPlayer = new Map();
    for (const row of projections ?? []) {
      if (row.company !== 'rotowire' || row.category !== 'proj' || !games.has(String(row.game_id))) continue;
      const previous = projectionByPlayer.get(row.player_id);
      if (!previous || row.last_modified > previous.last_modified) projectionByPlayer.set(row.player_id, row);
    }
    const lineups = matchups.filter(row => row.matchup_id != null).map(row => {
      const team = {id:row.roster_id, fixed:row.custom_points ?? row.points, players:[]};
      if (row.custom_points != null || final) return team;
      const savedLineup = lineupSnapshot?.season === data.season
        ? lineupSnapshot.weeks?.[week]?.teams?.[row.roster_id] : null;
      if (!savedLineup?.length) throw Error(`Saved lineup unavailable for ${name(team.id)}.`);
      const gameForPlayer = id =>
        games.get(String(projectionByPlayer.get(id)?.game_id)) ?? gameByTeam.get(players[id]?.[0]);
      // Keep completed points and replace any partial scores with full-game draws.
      for (const [index, id] of row.starters.entries()) {
        if (!id || id === '0' || gameForPlayer(id)?.status === 'complete') continue;
        team.fixed -= row.starters_points?.[index] ?? row.players_points?.[id] ?? 0;
      }
      for (const {playerId: id, projectedPoints: mean} of savedLineup) {
        // An empty slot adds zero points and zero variance.
        if (!id || id === '0') continue;
        const projection = projectionByPlayer.get(id);
        const metadata = players[id];
        const game = gameForPlayer(id);
        if (!game && metadata) continue;
        if (game?.status === 'complete') continue;
        const ppr = projection?.stats?.pts_ppr;
        const curve = varianceCurves[projection?.player?.position ?? metadata?.[1]];
        if (!Number.isFinite(mean) || !Number.isFinite(ppr) || !curve) {
          throw Error(`A usable RotoWire projection is missing for a starter on ${name(team.id)}.`);
        }
        team.players.push({mean, sd:ppr === 0 ? 0 : Math.sqrt(curve[0] + curve[1] * Math.max(2,ppr))});
      }
      return team;
    });
    return {results:sampleMedian(validate(lineups)), final};
  }

  function lineupSlotAverages(teamId) {
    const savedWeeks = lineupSnapshot?.season === data.season ? lineupSnapshot.weeks : null;
    const playedWeeks = Object.entries(savedWeeks ?? {})
      .filter(([week, snapshot]) => Number(week) <= 14 && snapshot.source === 'played')
      .map(([, snapshot]) => snapshot.teams);
    if (!playedWeeks.length) return '<p>No completed lineup scores available.</p>';

    const leagueTeams = [...teams.values()];
    const contenders = leagueTeams.filter(team => winRate(team) > 0.2);
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const slotLabels = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX1', 'FLEX2', 'SUPERFLEX'];
    const rows = slotLabels.map((label, index) => {
      const averages = new Map(leagueTeams.map(team => {
        const scores = playedWeeks.map(week => week?.[team.id])
          .filter(lineup => lineup?.some(slot => Number.isFinite(slot.actualPoints)))
          .map(lineup => {
            const slot = lineup[index];
            if (slot && (!slot.playerId || slot.playerId === '0')) return 0;
            return slot?.actualPoints;
          }).filter(Number.isFinite);
        return [team.id, mean(scores)];
      }));
      const average = averages.get(teamId);
      const leagueAverage = mean([...averages.values()].filter(Number.isFinite));
      const contendingAverage = mean(contenders.map(team => averages.get(team.id)).filter(Number.isFinite));
      const delta = average == null || contendingAverage == null ? 0 : average - contendingAverage;
      const distance = Math.abs(delta);
      const tone = distance <= 0.5 ? 'neutral' : delta > 0 ? 'above' : 'below';
      const intensity = distance > 1.5 ? ' vivid' : '';
      return `<tr><th scope="row">${label}</th><td class="slot-average ${tone}${intensity}">${points(average, 1)}</td>
        <td>${points(contendingAverage, 1)}</td><td>${points(leagueAverage, 1)}</td></tr>`;
    });
    return table(['Slot', 'AVG', 'Contending AVG', 'League AVG'].map(label => `<th scope="col">${label}</th>`), rows);
  }

  function leagueTeams() {
    const team = teams.get(state.team);
    const showLineups = state.teamSection === 'Lineups';
    const savedLineup = showLineups && lineupSnapshot?.season === data.season
      ? lineupSnapshot.weeks?.[state.lineupWeek]?.teams?.[state.team] : null;
    const bench = team.bench.filter(player => !player.reserveTag && !player.unavailable && player.average > 8);
    const reserve = team.bench.filter(player => player.reserveTag);
    const picks = data.picks.filter(pick => pick.owner === state.team)
      .sort((a,b) => a.year - b.year || a.round - b.round || name(a.original).localeCompare(name(b.original)));
    const playerCells = player =>
      [player?.name ?? '—', player?.rank ?? '—', points(player?.total, 0), points(player?.average, 1)];
    const pickCards = [1, 2, 3].map(offset => {
      const year = data.season + offset;
      const rows = picks.filter(pick => pick.year === year).map(pick => [pick.round, name(pick.original)]);
      return `<section class="card"><h3>${year}</h3>${rows.length
        ? simpleTable(['Round','Original team'], rows) : '<p>No picks available.</p>'}</section>`;
    }).join('');
    const headers = ['Player','Rank','TTL','AVG'];
    const metrics = [
      ['Average Points', team.analytics.average],
      ['Starter Average Points', team.analytics.starterAverage],
      ['Points Standard Deviation', team.analytics.variance == null ? null : Math.sqrt(team.analytics.variance)],
    ];
    return `<div class="heading"><div><h2>League Teams</h2>
      <div class="team-subtabs" role="group" aria-label="Team sections">${teamSections.map(section =>
        `<button type="button" data-team-section="${section}" aria-pressed="${section === state.teamSection}">${section}</button>`
      ).join('')}</div></div>
      <div class="filters">${select('Team','team', teamOptions, state.team)}
      ${showLineups ? select('Week', 'lineupWeek', matchupWeeks.slice().reverse().map(week =>
        [week, `Week ${week}`]), state.lineupWeek) : ''}</div></div>
      ${state.teamSection === 'Assets' ? `<div class="assets"><section class="stack"><h3>Roster</h3>
      <section class="card"><h3>Lineup</h3><p>Selected by season average.</p>
      ${simpleTable(['Slot', ...headers], team.lineup.map(({slot, player}) => [slot, ...playerCells(player)]))}</section>
      <section class="card"><h3>Bench</h3>${bench.length ? simpleTable(headers, bench.map(playerCells))
        : '<p>No bench players.</p>'}</section>
      <section class="card"><h3>Reserve</h3>${reserve.length ? simpleTable(['Player','Tag','AVG'],
        reserve.map(player => [player.name, player.reserveTag, points(player.average, 1)]))
        : '<p>No reserve players.</p>'}</section></section>
      <section class="stack pick-years"><h3>Draft Picks</h3>${pickCards}
      <p>Pick ownership uses Sleeper trades and the league’s current draft settings.</p></section></div>`
      : state.teamSection === 'Stats' ? `<section class="analytics"><h3>Analytics</h3><dl class="metrics">${metrics.map(([label, value]) =>
        `<div class="card"><dt>${label}</dt><dd>${points(value, 1)}</dd></div>`).join('')}</dl></section>
        <section class="card"><h3>Average Points by Position</h3>${lineupSlotAverages(state.team)}</section>
        <p>A team is regarded as 'contending' if their win percentage is above 20%.</p>`
      : `<p>View weekly lineups as they are recorded internally by our system.</p>
      ${savedLineup?.length ? table(['Slot', 'Player', 'PTS'].map(label => `<th scope="col">${label}</th>`),
        savedLineup.map(({slot, playerId, actualPoints, pregamePoints}) => {
          const player = playerId && playerId !== '0' ? lineupSnapshot.players?.[playerId] ?? playerId : '—';
          return `<tr><td>${html(slot)}</td><td>${html(player)}</td><td>
            <span class="lineup-points"><strong aria-label="Actual points">${actualPoints == null ? '' : points(actualPoints)}</strong>
            <span aria-label="Pregame projection">${pregamePoints ? points(pregamePoints) : '0'}</span></span></td></tr>`;
        }))
      : '<p>No saved lineup for this week.</p>'}
      <p>Lineups are configured according to the following rules.</p>
      <ul>
        <li><strong>Past Weeks:</strong> The 9 starters are rearranged greedily from top to bottom according to their pregame projections. The intended effect is to standardize the lineup so it functions like a depth chart. This is visually insightful, but more importantly it allows for the more accurate estimation of 'Average Points by Position' in the 'Stats' subtab.</li>
        <li><strong>Current and Future Weeks:</strong> The lineup is selected to reflect the maximum possible projection the manager could achieve at this point in time. For the current week, this means any locked players remain where they are.</li>
      </ul>`}`;
  }

  function draft() {
    const year = data.season + 1;
    const order = [...teams.values()].sort(compareStandings).reverse();
    const picks = data.picks.filter(pick => pick.year === year);
    const owners = new Map(picks.map(pick => [`${pick.round}:${pick.original}`, pick.owner]));
    const rounds = [...new Set(picks.map(pick => pick.round))].sort((a, b) => a - b);
    const labels = order.map(team => `<div class="draft-label" tabindex="0" data-draft-team="${team.id}"
      aria-label="Highlight picks owned by ${html(team.name)}"><span>${html(team.name)}</span></div>`).join('');
    const tiles = rounds.flatMap(round => order.map((team, index) => {
      const owner = owners.get(`${round}:${team.id}`);
      const ownerName = owner == null ? 'Unassigned' : name(owner);
      const description = html(`Pick ${round}.${String(index + 1).padStart(2, '0')}, originally ${team.name}, owned by ${ownerName}`);
      return `<div class="draft-pick" data-owner="${owner ?? ''}" role="listitem" aria-label="${description}"
        title="${description}"><span>${html(ownerName)}</span></div>`;
    })).join('');
    return `<div class="heading"><div><h2>${year} Draft Order</h2>
      <p>Projected from the standings in reverse order. Each tile shows the current pick owner.</p></div></div>
      <div class="draft-scroll" tabindex="0" role="region" aria-label="Draft board">
        <div class="draft-board" role="list" style="--teams:${order.length}">${labels}${tiles}</div>
      </div>${draftProjections(year)}`;
  }

  function updateDraftFade(board) {
    board.toggleAttribute('data-fade-left', board.scrollLeft > 1);
    board.toggleAttribute('data-fade-right', board.scrollLeft + board.clientWidth < board.scrollWidth - 1);
  }

  const trialCount = 50_000;
  const postseasonsPerTrial = 3;
  const postseasonTrialCount = trialCount * postseasonsPerTrial;
  let deviationPercent = 20;
  let playoffResults;
  let draftResults;
  let projectedPickOwner = 'all';
  let draftDeviation = 20;
  let finishView = 'regular';
  const scoreOverrides = new Map();
  let overridesEnabled = false;
  let overridesOpen = false;
  const normalDraw = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

  function playoffModelReady() {
    const model = data.playoffModel;
    return model.supported
      && Array.from({length:model.schedule.length + 3}, (_, index) =>
        index < model.schedule.length ? data.medianModel.lastScored + 1 + index
          : data.medianModel.playoffStart + index - model.schedule.length
      ).every(week => data.teams.every(team => Number.isFinite(playoffMean(week, team.id))))
      && model.schedule.every(week => {
        const ids = week.flat();
        return week.every(game => game.length === 2) && ids.length === teams.size
          && new Set(ids).size === teams.size && ids.every(id => teams.has(id));
      });
  }

  function playoffMean(week, teamId) {
    if (scoreFinalized(week, teamId)) {
      return data.weeks[week]?.flat().find(row => row.id === teamId)?.points;
    }
    return projectedLineupTotal(week, teamId);
  }

  function bracketFinish(seeds, winner, loserAdvances, draftOrder = false) {
    const [bye1, bye2, seed3, seed4, seed5, seed6] = seeds;
    const advancing = (a, b, round) => {
      const winningSeed = winner(a, b, round);
      return loserAdvances ? a + b - winningSeed : winningSeed;
    };
    const advance36 = advancing(seed3, seed6, 0);
    const advance45 = advancing(seed4, seed5, 0);
    const exit36 = seed3 + seed6 - advance36;
    const exit45 = seed4 + seed5 - advance45;
    const finalist1 = advancing(bye1, advance45, 1);
    const finalist2 = advancing(bye2, advance36, 1);
    const exitSemi1 = bye1 + advance45 - finalist1;
    const exitSemi2 = bye2 + advance36 - finalist2;
    const finalWinner = winner(finalist1, finalist2, 2);
    if (draftOrder) {
      return [finalWinner, finalist1 + finalist2 - finalWinner,
        Math.min(exitSemi1, exitSemi2), Math.max(exitSemi1, exitSemi2),
        Math.min(exit36, exit45), Math.max(exit36, exit45)];
    }
    const thirdGameWinner = winner(exitSemi1, exitSemi2, 2);
    const fifthGameWinner = winner(exit36, exit45, 1);
    const finalLoser = finalist1 + finalist2 - finalWinner;
    const thirdGameLoser = exitSemi1 + exitSemi2 - thirdGameWinner;
    const fifthGameLoser = exit36 + exit45 - fifthGameWinner;
    return loserAdvances
      ? [fifthGameWinner, fifthGameLoser, thirdGameWinner, thirdGameLoser, finalWinner, finalLoser]
      : [finalWinner, finalLoser, thirdGameWinner, thirdGameLoser, fifthGameWinner, fifthGameLoser];
  }

  function simulatePlayoffs(draftOrder = false) {
    const deviation = draftOrder ? draftDeviation : deviationPercent;
    const useOverrides = !draftOrder && overridesEnabled;
    const model = data.playoffModel;
    const counts = new Map(data.teams.map(team => [team.id, {
      id:team.id, champion:0, bye:0, qualified:0, winRate:0,
      finishes:Array(teams.size).fill(0), postseasonFinishes:Array(teams.size).fill(0),
    }]));
    const k = deviation / 100;
    const weeklyGames = model.schedule.map((games, index) => {
      const week = data.medianModel.lastScored + 1 + index;
      return games.map(game => game.map(id => {
        const mean = playoffMean(week, id);
        const finalized = scoreFinalized(week, id);
        const override = useOverrides && !finalized ? scoreOverrides.get(`${week}:${id}`) : undefined;
        return {id, mean, fixed: override ?? (finalized ? Math.round(mean * 100) : undefined)};
      }));
    });
    const playoffMeans = Array.from({length:3}, (_, round) => new Map(data.teams.map(team =>
      [team.id, playoffMean(data.medianModel.playoffStart + round, team.id)])));
    const remainingGames = model.schedule.length * (model.medianGame ? 2 : 1);
    const cutoffs = {playoff:0, bye:0};
    function draw(mean) {
      return Math.max(0, Math.round((mean + normalDraw() * k * mean) * 100));
    }

    for (let trial = 0; trial < trialCount; trial++) {
      const standings = new Map(data.teams.map(team => [team.id, {
        id:team.id, effectiveWins:team.wins + team.ties / 2,
        games:team.wins + team.losses + team.ties + remainingGames,
        pf:Math.round(team.pf * 100),
        tiebreak:undefined,
      }]));
      for (const week of weeklyGames) {
        const scores = [];
        for (const [home, away] of week) {
          const a = standings.get(home.id), b = standings.get(away.id);
          const x = home.fixed ?? draw(home.mean), y = away.fixed ?? draw(away.mean);
          a.effectiveWins += x === y ? .5 : Number(x > y);
          b.effectiveWins += x === y ? .5 : Number(y > x);
          a.pf += x;
          b.pf += y;
          scores.push({team:a, score:x}, {team:b, score:y});
        }
        if (model.medianGame) {
          scores.sort((a,b) => a.score - b.score);
          const middle = scores.length / 2;
          const median = (scores[middle - 1].score + scores[middle].score) / 2;
          scores.forEach(({team, score}) => {
            team.effectiveWins += score === median ? .5 : Number(score > median);
          });
        }
      }
      const ranked = [...standings.values()];
      for (const team of ranked) {
        team.winRate = team.effectiveWins / team.games;
        counts.get(team.id).winRate += team.winRate;
      }
      ranked.sort((a,b) => b.winRate - a.winRate || b.pf - a.pf ||
        (a.tiebreak ??= Math.random()) - (b.tiebreak ??= Math.random()));
      ranked.forEach((team, position) => counts.get(team.id).finishes[position]++);
      const seeds = ranked.slice(0, 6);
      cutoffs.playoff += seeds[5].winRate;
      cutoffs.bye += seeds[1].winRate;
      seeds.forEach(({id}, seed) => {
        counts.get(id).qualified++;
        if (seed < 2) counts.get(id).bye++;
      });
      const winner = (a, b, round) => {
        const means = playoffMeans[round];
        const difference = draw(means.get(ranked[a].id)) - draw(means.get(ranked[b].id));
        return difference === 0 ? Math.min(a,b) : difference > 0 ? a : b;
      };
      for (let postseasonTrial = 0; postseasonTrial < postseasonsPerTrial; postseasonTrial++) {
        const topFinish = bracketFinish([0, 1, 2, 3, 4, 5], winner, false, draftOrder);
        if (draftOrder) {
          topFinish.concat([6, 7, 8, 9, 10, 11]).forEach((seed, position) => {
            counts.get(ranked[seed].id).postseasonFinishes[ranked.length - 1 - position]++;
          });
          continue;
        }
        const bottomFinish = bracketFinish([11, 10, 9, 8, 7, 6], winner, true);
        counts.get(ranked[topFinish[0]].id).champion++;
        topFinish.concat(bottomFinish).forEach((seed, position) => {
          counts.get(ranked[seed].id).postseasonFinishes[position]++;
        });
      }
    }
    const {wins, losses, ties} = data.teams[0];
    const games = wins + losses + ties + remainingGames;
    return {rows:[...teams.values()].sort(compareStandings).map(team => counts.get(team.id)), cutoffs, games,
      deviationPercent:deviation};
  }

  const percent = (count, total = trialCount) => `${(100 * count / total).toFixed(1)}%`;

  function simulationControls(ready, deviation, view) {
    return `<div class="card playoff-controls">
        <label for="deviation-percent">Standard deviation multiplier (k)</label>
        <div class="deviation-control">
          <input id="deviation-percent" type="range" min="0" max="30" step="5" value="${deviation}">
          <output for="deviation-percent">${deviation}%</output>
        </div>
        <div class="playoff-run"><button data-run-playoffs="${view}" ${ready ? '' : 'disabled'}>Run Monte Carlo</button>
          <span class="simulation-spinner" role="status" aria-label="Running simulation" hidden></span></div>
      </div>`;
  }

  function finishGrid(rows, field, total) {
    return `<div class="finish-scroll"><div class="finish-grid" style="grid-template-columns:11rem repeat(${teams.size}, 3.5rem)">
          <div></div>${Array.from({length:teams.size}, (_, index) => `<div class="finish-position">${index + 1}</div>`).join('')}
          ${rows.map(row => {
            const finishes = row[field];
            const mostLikely = finishes.indexOf(Math.max(...finishes));
            return `<div class="finish-team">${html(name(row.id))}</div>${finishes.map((count, index) => {
            const intensity = Math.sqrt(count / total);
            const color = [48, 55, 53].map((channel, i) =>
              Math.round(channel + ([214, 248, 134][i] - channel) * intensity));
            const label = html(`${name(row.id)}, position ${index + 1}, ${percent(count, total)}`);
            const emphasis = index === mostLikely ? 'color:#000;font-weight:700' : 'color:#fff';
            return `<div class="finish-cell" title="${label}" style="background-color:rgb(${color.join(',')});${emphasis}">${percent(count, total)}</div>`;
          }).join('')}`;
          }).join('')}
        </div></div>`;
  }

  state.pickCoverage = 80;

  function pickRangeEndpoint(counts, coverage, fromRight) {
    const tail = postseasonTrialCount * (100 - coverage);
    let cumulative = 0;
    for (let offset = 0; offset < counts.length; offset++) {
      const index = fromRight ? counts.length - 1 - offset : offset;
      cumulative += counts[index];
      if (200 * cumulative > tail) return index + 1;
    }
  }

  function projectedOwnershipBoard(year) {
    const picks = data.picks.filter(pick => pick.year === year);
    const rounds = [...new Set(picks.map(pick => pick.round))].sort((a, b) => a - b);
    const options = [['all', 'No Team Selected'], ...draftResults.rows.map(row => [String(row.id), name(row.id)])];
    const standingByTeam = new Map([...teams.values()].sort(compareStandings)
      .map((team, index) => [team.id, index]));
    const positions = new Map(draftResults.rows.map(row => {
      let mean = 0;
      row.postseasonFinishes.forEach((count, index) => {
        const slot = index + 1;
        mean += slot * count / postseasonTrialCount;
      });
      const low = pickRangeEndpoint(row.postseasonFinishes, state.pickCoverage, false);
      const high = pickRangeEndpoint(row.postseasonFinishes, state.pickCoverage, true);
      return [row.id, {mean, low, high}];
    }));
    const x = slot => 100 * (slot - 1) / (teams.size - 1);
    return `<section class="analytics">
      <div class="heading"><div><h3>Projected Pick Ownership</h3>
      <p>Dots show expected pick positions. Bars span the middle ${state.pickCoverage}% of outcomes.</p></div>
      <div class="filters"><label>m (${state.pickCoverage}%)
        <input type="range" data-field="pickCoverage" min="20" max="95" step="5" value="${state.pickCoverage}">
      </label>${select('Pick owner', 'projectedPickOwner', options, projectedPickOwner)}</div></div>
      <div class="finish-scroll" tabindex="0" role="region" aria-label="Projected pick ownership">
        ${rounds.map(round => {
          const roundPicks = picks.filter(pick => pick.round === round && positions.has(pick.original))
            .sort((a, b) => standingByTeam.get(a.original) - standingByTeam.get(b.original));
          return `<div class="pick-range-round"><h4>Round ${round}</h4><div class="pick-range-axis"
            style="--pick-count:${roundPicks.length}">
            ${Array.from({length:teams.size}, (_, index) =>
              `<span class="pick-range-tick" style="left:${x(index + 1)}%">${index + 1}</span>`).join('')}
            ${roundPicks.map((pick, index) => {
              const {mean, low, high} = positions.get(pick.original);
              const label = html(`Round ${round}, originally ${name(pick.original)}, owned by ${pick.owner == null ? 'Unassigned' : name(pick.owner)}. Expected pick ${mean.toFixed(2)}. Middle ${state.pickCoverage}% range ${low} to ${high}.`);
              const highlighted = String(pick.owner) === projectedPickOwner;
              return `<div class="pick-range ${highlighted ? 'pick-range-owned' : ''}" style="--lane:${index}">
                <span class="pick-range-bar" style="left:${x(low)}%;width:${x(high)-x(low)}%"></span>
                <span class="pick-range-dot" tabindex="0" title="${label}" aria-label="${label}" style="left:${x(mean)}%"></span>
              </div>`;
            }).join('')}
          </div></div>`;
        }).join('')}
      </div>
    </section>`;
  }

  function draftProjections(year) {
    const ready = playoffModelReady();
    return `<section class="analytics draft-projections">
      <div class="heading"><div><h2>${year} Draft Projections</h2>
      <p>Simulate ${trialCount.toLocaleString()} regular seasons and ${postseasonsPerTrial} postseasons per season.</p></div></div>
      ${simulationControls(ready, draftDeviation, 'draft')}
      ${!ready ? '<p>Simulation requires a complete remaining schedule and lineup projections through Week 17.</p>'
        : draftResults ? `${projectedOwnershipBoard(year)}<section class="analytics finish-heatmap"><h3>Draft position probabilities</h3>
          ${finishGrid(draftResults.rows, 'postseasonFinishes', postseasonTrialCount)}</section>` : ''}
      </section>`;
  }

  function playoffs() {
    const ready = playoffModelReady();
    const cutoffRecord = rateTotal => {
      const games = playoffResults.games;
      const wins = Math.round(10 * games * rateTotal / trialCount) / 10;
      return `${points(wins, 1)} – ${points(games - wins, 1)}`;
    };
    const overrideWeeks = [currentWeek, currentWeek + 1].map(week => {
      const games = week < data.medianModel.playoffStart ? data.weeks[week] : null;
      const editable = games?.length && games.every(game => game.length === 2 &&
        game.every(row => week > data.medianModel.lastScored || Number.isFinite(row.points)));
      return `<section><h3>Week ${week}</h3>${editable ? `<div class="cards">${games.map(game =>
        `<div class="card">${game.map(row => {
          if (scoreFinalized(week, row.id)) {
            return `<div class="override-team">${html(name(row.id))}<strong class="override-final">${points(row.points)}</strong></div>`;
          }
          const projection = playoffMean(week, row.id);
          const key = `${week}:${row.id}`;
          const value = scoreOverrides.get(key);
          return `<label class="override-team">${html(name(row.id))}
            <input type="text" inputmode="decimal" data-score-override="${key}" value="${value == null ? '' : value / 100}"
              placeholder="${Number.isFinite(projection) ? '~' + points(projection) : ''}"></label>`;
        }).join('')}</div>`).join('')}</div>` : '<p>No regular-season matchups available.</p>'}</section>`;
    }).join('');
    return `<div class="heading"><div><h2>Playoffs</h2>
      <p>Simulate ${trialCount.toLocaleString()} regular seasons and ${postseasonsPerTrial} postseasons per season.</p></div></div>
      ${simulationControls(ready, deviationPercent, "playoffs")}
      <details class="card score-overrides" ${overridesOpen ? 'open' : ''}>
        <summary>Score overrides</summary>
        <label><input type="checkbox" data-enable-overrides ${overridesEnabled ? 'checked' : ''}> Enable score overrides</label>
        <div data-override-fields ${overridesEnabled ? '' : 'hidden'}>
        <p>Enter a final team score to use in every trial. Blank fields use the recorded score for completed weeks and the simulation model for other weeks.</p>
        ${overrideWeeks}
        </div>
      </details>
      <p>Scoring standard deviation is k × the team’s expected points for that week.
      Expected points come from saved lineup projections through Week 17.</p>
      ${!ready ? '<p>Simulation requires a complete remaining schedule, lineup projections for every simulated week, and a supported six-team bracket before the playoffs begin.</p>'
      : playoffResults ? `<p>Results with k = ${playoffResults.deviationPercent}%.</p>
        ${simpleTable(['Team','Championship','Bye Qualification','Playoff Qualification','Expected Win Rate'],
        playoffResults.rows.map(row => [name(row.id), percent(row.champion, postseasonTrialCount), percent(row.bye), percent(row.qualified), percent(row.winRate)]))}
        <section class="analytics finish-heatmap"><div class="heading"><h3>Finish probabilities</h3>
          ${select('Season stage', 'finishView', [['regular','Regular season'], ['postseason','Postseason']], finishView)}
        </div>
        ${finishGrid(playoffResults.rows, finishView === 'postseason' ? 'postseasonFinishes' : 'finishes',
          finishView === 'postseason' ? postseasonTrialCount : trialCount)}
        </section>
        <section class="analytics"><dl class="metrics">
        <div class="card"><dt>Projected Playoff Cutoff</dt><dd>${cutoffRecord(playoffResults.cutoffs.playoff)}</dd></div>
        <div class="card"><dt>Projected Bye Cutoff</dt><dd>${cutoffRecord(playoffResults.cutoffs.bye)}</dd></div>
        </dl><p>Average records of the 6th and 2nd seeds across all trials. Ties count as half a win and half a loss.</p></section>`
        : '<p>Run the simulation to see estimated probabilities.</p>'}`;
  }

  const assetKey = name => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const playerKey = name => assetKey(name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/i, ''));
  const ktcAssets = new Map((data.ktc?.assets ?? []).map(([name, position, age, value]) =>
    [assetKey(name), {position, age:age > 0 ? age : null, value}]));
  const playerAliases = new Map([['kennygainwell','kennethgainwell'], ['chigokonkwo','chigoziemokonkwo']]);
  const ktcPlayers = new Map();
  for (const [name, position] of data.ktc?.assets ?? []) {
    if (position === 'RDP') continue;
    const key = playerKey(name);
    ktcPlayers.set(key, ktcPlayers.has(key) ? null : ktcAssets.get(assetKey(name)));
  }
  const projectedDraftOrder = [...teams.values()].sort(compareStandings).reverse();
  const teamValues = projectedDraftOrder.map(team => {
    const assets = [...team.lineup.map(row => row.player).filter(Boolean), ...team.bench].map(player => {
      const key = playerKey(player.name);
      const match = ktcAssets.get(assetKey(player.name)) ?? ktcPlayers.get(playerAliases.get(key) ?? key);
      return {name:player.name, type:match?.position ?? 'Player', age:match?.age, value:match?.value};
    });
    for (const pick of data.picks.filter(pick => pick.owner === team.id)) {
      const slot = projectedDraftOrder.findIndex(original => original.id === pick.original);
      const tier = pick.year === data.season + 1 && slot >= 0 ?
        ['Early','Mid','Late'][Math.floor(3 * slot / projectedDraftOrder.length)] : 'Mid';
      const round = ['1st','2nd','3rd','4th'][pick.round - 1] ?? `${pick.round}th`;
      const match = ktcAssets.get(assetKey(`${pick.year} ${tier} ${round}`));
      assets.push({name:`${pick.year} ${tier} ${round} · ${name(pick.original)}`, type:'Pick',
        age:22 - (pick.year - data.season), value:match?.value});
    }
    assets.sort((a,b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));
    const total = assets.reduce((sum, asset) => sum + (asset.value ?? 0), 0);
    const aged = assets.filter(asset => asset.age != null && asset.value != null);
    const ageWeight = aged.reduce((sum, asset) => sum + asset.value, 0);
    const age = ageWeight ? aged.reduce((sum, asset) => sum + asset.age * asset.value, 0) / ageWeight : null;
    return {id:team.id, assets, total, age, unvalued:assets.filter(asset => asset.value == null).length};
  });

  function valueChart(selected) {
    const plotted = teamValues.filter(team => team.age != null);
    if (!plotted.length) return '';
    const minAge = Math.floor(Math.min(...plotted.map(team => team.age)) * 2) / 2;
    const maxAge = Math.max(minAge + 1, Math.ceil(Math.max(...plotted.map(team => team.age)) * 2) / 2);
    const maxValue = Math.max(...teamValues.map(team => team.total));
    const x = percent => 95 + 640 * (percent - 50) / 50;
    const y = age => 305 - 275 * (age - minAge) / (maxAge - minAge);
    const grid = Array.from({length:6}, (_, index) => {
      const age = minAge + (maxAge - minAge) * index / 5;
      const percent = 50 + index * 10;
      return `<line x1="${x(percent)}" y1="30" x2="${x(percent)}" y2="305"/><text x="${x(percent)}" y="330" text-anchor="middle">${percent}%</text>
        <line x1="95" y1="${y(age)}" x2="735" y2="${y(age)}"/><text x="85" y="${y(age) + 5}" text-anchor="end">${points(age, 2)}</text>`;
    }).join('');
    return `<svg class="value-chart" viewBox="0 0 770 375" role="group" aria-label="Team value by value-weighted age">
      ${grid}<text x="415" y="360" text-anchor="middle">KTC value relative to league leader</text>
      <text transform="translate(20 168) rotate(-90)" text-anchor="middle">Value-weighted age</text>
      ${plotted.filter(team => team.total >= maxValue / 2).map(team => {
        const percent = 100 * team.total / maxValue;
        const description = html(`${name(team.id)}, ${points(percent, 1)}% of leader’s value, weighted age ${points(team.age, 2)}`);
        return `<circle role="button" tabindex="0" data-value-team="${team.id}" aria-pressed="${team.id === selected}"
          aria-label="${description}" cx="${x(percent)}" cy="${y(team.age)}" r="${team.id === selected ? 9 : 7}"><title>${description}</title></circle>`;
      }).join('')}</svg>`;
  }

  function tradeValues() {
    if (!data.ktc) return '<h2>Trade Values</h2><p>The KTC snapshot is unavailable.</p>';
    const selected = state.valueTeam ?? state.team;
    const team = teamValues.find(team => team.id === selected);
    return `<div class="heading"><div><h2>Trade Values</h2>
      <p>Crowdsourced Superflex values from <a href="https://keeptradecut.com/dynasty-rankings">KeepTradeCut</a>,
      captured ${new Date(data.ktc.updated).toLocaleDateString()}.</p></div>
      ${select('Team','valueTeam',teamOptions,selected)}</div>
      ${valueChart(selected)}
      <div class="heading"><div><h3>${html(name(selected))}</h3>
      <p>${points(team.total, 0)} total KTC value · ${points(team.age, 2)} value-weighted age
      · ${team.unvalued} assets without a KTC match</p></div></div>
      ${simpleTable(['Asset','Type','Age','KTC value'], team.assets.map(asset =>
        [asset.name, asset.type, points(asset.age, asset.type === 'Pick' ? 0 : 1), points(asset.value, 0)]))}
      <p>Next-draft pick tiers use projected draft order. Later picks use the mid-round value.
      Pick ages start at 21 for the next draft and drop by one per year.
      Total value sums matched assets. Weighted age uses matched values with a known age.</p>`;
  }

  function methodology() {
    return `<h2>Methodology</h2>
      <section class="card analytics">
        <h3>Data</h3>
        <p>The dashboard stores two main categories of data. Both are intended to refresh daily.</p>
        <ul>
          <li><strong>League data</strong> comes from Sleeper and includes team records, matchup schedules and scores, rosters, starting lineups, league scoring rules, and draft pick ownership.</li>
          <li><strong>Projection data</strong> comes from RotoWire through Sleeper’s projections feed. The dashboard applies the league’s scoring rules to the weekly player projections and uses them to build projected lineups and simulate outcomes.</li>
        </ul>
        <p><strong>Sync Data</strong> rebuilds the same Sleeper snapshots as the scheduled refresh and shows the result in this tab.</p>
      </section>
      <section class="card analytics">
        <h3>Lineups</h3>
        <p>Completed weeks use the starters recorded by Sleeper. For upcoming games, the dashboard fills eligible slots to maximize the lineup’s total RotoWire projection under league scoring rules.</p>
        <p>Once a player’s NFL game starts, a Sleeper starter stays in their assigned slot and a bench player stays on the bench. The dashboard reoptimizes the remaining slots using players whose games have yet to start.</p>
      </section>
      <section class="card analytics">
        <h3>Playoffs</h3>
        <p>The model simulates ${trialCount.toLocaleString()} regular seasons using weekly lineup projections. Each set of final standings seeds ${postseasonsPerTrial} independent postseason simulations. Both brackets use fixed matchups based on regular-season finish.</p>
        <h4>Championship bracket</h4>
        <p>Seeds 1 and 2 have byes. Winners advance toward the championship.</p>
        <pre style="overflow-x:auto">Week 15                 Week 16                       Week 17
3 vs 6 ── winner ─────► 2 vs winner of 3 vs 6 ─┐
4 vs 5 ── winner ─────► 1 vs winner of 4 vs 5 ─┴─────► Winners play for 1st / 2nd
                              Semifinal losers ──────► Play for 3rd / 4th
Both quarterfinal losers ──► Play for 5th / 6th</pre>
        <h4>Toilet Bowl bracket</h4>
        <p>Seeds 11 and 12 have byes. Losers advance toward the Toilet Bowl.</p>
        <pre style="overflow-x:auto">Week 15                 Week 16                       Week 17
7 vs 10 ── loser ─────► 11 vs loser of 7 vs 10 ─┐
8 vs 9 ─── loser ─────► 12 vs loser of 8 vs 9 ──┴─────► Losers play for 11th / 12th
                              Semifinal winners ─────► Play for 9th / 10th
Both first-round winners ──► Play for 7th / 8th</pre>
        <p>The winner of each placement game earns the better finish. A future option will let you enter power rankings to model semifinal reseeding.</p>
      </section>`;
  }

  function render(focusSelector) {
    if (signal.aborted) return;
    const overrides = content.querySelector('.score-overrides');
    if (overrides) overridesOpen = overrides.open;
    tabs.forEach(tab => {
      if (tab.dataset.view === state.view) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    content.innerHTML = {standings, matchups, teams:leagueTeams, draft, playoffs, methodology, values:tradeValues}[state.view]();
    const board = content.querySelector('.draft-scroll');
    if (board) {
      updateDraftFade(board);
      board.addEventListener('scroll', () => updateDraftFade(board), {passive:true});
      const picks = board.querySelectorAll('.draft-pick');
      const highlight = () => {
        const label = board.querySelector('.draft-label:hover') ?? board.querySelector('.draft-label:focus-visible');
        picks.forEach(pick => pick.toggleAttribute('data-highlighted', pick.dataset.owner === label?.dataset.draftTeam));
      };
      board.querySelectorAll('.draft-label').forEach(label => {
        for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur']) {
          label.addEventListener(event, () => requestAnimationFrame(highlight));
        }
      });
    }
    if (focusSelector) content.querySelector(focusSelector)?.focus();
  }

  tabs.forEach(tab => tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    render();
  }, listenerOptions));
  content.addEventListener('click', async event => {
    const point = event.target.closest('[data-value-team]');
    if (point) {
      state.valueTeam = Number(point.dataset.valueTeam);
      render(`[data-value-team="${state.valueTeam}"]`);
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.teamSection) {
      state.teamSection = button.dataset.teamSection;
      render(`[data-team-section="${state.teamSection}"]`);
      return;
    }
    const {sort, team} = button.dataset;
    if (button.hasAttribute('data-run-median')) {
      const week = state.week;
      medianForecasts.set(week, {loading:true});
      render();
      try {
        medianForecasts.set(week, await loadMedian(week));
      } catch (error) {
        medianForecasts.set(week, {message:error.message});
      }
      if (state.view === 'matchups' && state.week === week) render('[data-run-median]');
    } else if (button.hasAttribute('data-run-playoffs')) {
      button.disabled = true;
      const spinner = content.querySelector('.simulation-spinner');
      spinner.hidden = false;
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (signal.aborted) return;
        const view = button.dataset.runPlayoffs;
        if (view === 'draft') draftResults = simulatePlayoffs(true);
        else playoffResults = simulatePlayoffs();
        if (state.view === view) render('[data-run-playoffs]');
      } finally {
        spinner.hidden = true;
        button.disabled = false;
      }
    } else if (sort) {
      state.direction = state.sort === sort ? -state.direction : sort === 'name' ? 1 : -1;
      state.sort = sort;
      render(`[data-sort="${sort}"]`);
    } else if (team) {
      state.team = Number(team);
      state.view = 'teams';
      render('[data-field="team"]');
    }
  }, listenerOptions);
  content.addEventListener('keydown', event => {
    if (!event.target.matches('[data-value-team]') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    state.valueTeam = Number(event.target.dataset.valueTeam);
    render(`[data-value-team="${state.valueTeam}"]`);
  }, listenerOptions);
  content.addEventListener('input', event => {
    const {scoreOverride} = event.target.dataset;
    if (scoreOverride) {
      const input = event.target;
      const value = input.value;
      if (!/^-?\d*(?:[.,]\d*)?$/.test(value)) {
        const previous = scoreOverrides.get(scoreOverride);
        input.value = input.dataset.lastNumericText ?? (previous == null ? '' : String(previous / 100));
        return;
      }
      input.dataset.lastNumericText = value;
      const cents = value ? Math.round(Number(value.replace(',', '.')) * 100) : NaN;
      if (Number.isSafeInteger(cents)) scoreOverrides.set(scoreOverride, cents);
      else scoreOverrides.delete(scoreOverride);
      return;
    }
    if (event.target.id !== 'deviation-percent') return;
    const deviation = event.target.valueAsNumber;
    if (state.view === 'draft') draftDeviation = deviation;
    else deviationPercent = deviation;
    content.querySelector('output[for="deviation-percent"]').value = `${deviation}%`;
  }, listenerOptions);
  content.addEventListener('change', event => {
    if (event.target.matches('[data-enable-overrides]')) {
      overridesEnabled = event.target.checked;
      content.querySelector('[data-override-fields]').hidden = !overridesEnabled;
      return;
    }
    const {field} = event.target.dataset;
    if (!field) return;
    if (field === 'projectedPickOwner') {
      projectedPickOwner = event.target.value;
      render('[data-field="projectedPickOwner"]');
      return;
    }
    if (field === 'finishView') {
      finishView = event.target.value;
      render('[data-field="finishView"]');
      return;
    }
    state[field] = Number(event.target.value);
    render(`[data-field="${field}"]`);
  }, listenerOptions);
  window.addEventListener('resize', () => {
    const board = content.querySelector('.draft-scroll');
    if (board) updateDraftFade(board);
  }, listenerOptions);
  render();
}

async function initializeDashboard() {
  const syncButton = document.querySelector('#sync-data');
  const syncStatus = document.querySelector('#sync-status');
  const published = await publishedSnapshots();
  let cached;
  try {
    cached = JSON.parse(sessionStorage.getItem(sessionSnapshotKey));
  } catch (error) {
    console.warn('Could not restore this tab’s Sleeper sync.', error);
  }
  const useCached = Date.parse(cached?.league?.updated) > Date.parse(published.league.updated);
  await startDashboard(useCached ? cached : published);
  if (useCached) syncStatus.textContent = 'Synced for this tab.';
  syncButton.disabled = false;
  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    syncStatus.textContent = 'Syncing…';
    try {
      const payload = await syncSleeper();
      const snapshots = JSON.parse(payload);
      const view = document.querySelector('[data-view][aria-current="page"]')?.dataset.view;
      await startDashboard(snapshots, view);
      try {
        sessionStorage.setItem(sessionSnapshotKey, payload);
      } catch (error) {
        console.warn('Could not save this tab’s Sleeper sync across reloads.', error);
      }
      syncStatus.textContent = 'Synced for this tab.';
    } catch (error) {
      console.error('Sleeper sync failed.', error);
      syncStatus.textContent = 'Could not sync with Sleeper. Showing previous data.';
    } finally {
      syncButton.disabled = false;
    }
  });
}

initializeDashboard().catch(error => {
  console.error(error);
  document.querySelector('#content').textContent =
    'Could not load the Sleeper snapshot. Open the dashboard through GitHub Pages or a local web server.';
});
