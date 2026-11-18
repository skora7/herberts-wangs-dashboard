import {
  medianTrialCount, postseasonsPerTrial, postseasonTrialCount, sampleMedian, simulateSeason, trialCount,
} from './simulations.js';

const sessionSnapshotKey = 'dashboard-builder-snapshots-v1';
const lastRegularSeasonWeek = 14;
const lineupSlotLabels = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX1', 'FLEX2', 'SUPERFLEX'];
const defaultDeviationPercent = 20;
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
  const optionalSnapshot = path => fetch(path, {cache:'no-cache'})
    .then(response => response.ok ? response.json() : null)
    .catch(() => null);
  const projectionRequest = optionalSnapshot('./data/projections.json');
  const lineupRequest = optionalSnapshot('./data/lineups.json');
  const response = await fetch('./data/sleeper.json', {cache:'no-cache'});
  if (!response.ok) throw Error('Could not load the published Sleeper snapshot.');
  const data = await response.json();
  return {league: data, projections: await projectionRequest, lineups: await lineupRequest};
}

function startDashboard(snapshots, initialView) {
  const {league: data, projections: projectionSnapshot, lineups: lineupSnapshot} = snapshots;
  const projectionWeeks = projectionSnapshot?.season === data.season ? projectionSnapshot.weeks : null;
  const lineupWeeks = lineupSnapshot?.season === data.season ? lineupSnapshot.weeks : null;
  // A fresh snapshot gets fresh state and event handlers, including after a manual sync.
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
  const matchupWeeks = Array.from({length:lastRegularSeasonWeek}, (_, index) => lastRegularSeasonWeek - index);
  const currentWeek = data.currentWeek ?? weeks[0] ?? 1;
  const selectedWeek = Math.min(lastRegularSeasonWeek, currentWeek);
  const view = tabs.find(tab => !tab.hidden && tab.dataset.view === initialView)?.dataset.view ?? 'standings';
  const teamSections = ['Assets', 'Stats', 'Lineups'];
  const teamOptions = [...teams.values()].sort((a,b) => a.name.localeCompare(b.name)).map(team => [team.id, team.name]);
  const state = {
    view, sort:'record', direction:-1, week:selectedWeek, isolate:teamOptions[0]?.[0],
    team:data.teams[0]?.id, teamSection:'Assets', lineupWeek:selectedWeek, pickCoverage:80,
  };
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

  const columnHeaders = labels => labels.map(label => `<th scope="col">${html(label)}</th>`);

  function simpleTable(headers, rows) {
    return table(columnHeaders(headers), rows.map(row =>
      `<tr>${row.map(cell => `<td>${html(cell)}</td>`).join('')}</tr>`));
  }

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
    const savedLineups = lineupWeeks?.[week];
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
    .filter(({starters}) => starters?.length === lineupSlotLabels.length && starters.every(id =>
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

  // Fit player scoring variance from historical RotoWire projection errors, in squared PPR points.
  const varianceCurves = {QB:[36.4098,1.5083], RB:[.6254,4.2599], WR:[6.8302,3.8625], TE:[2.4392,4.1774]};
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
    const projections = projectionWeeks?.[week];
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
      const savedLineup = lineupWeeks?.[week]?.teams?.[row.roster_id];
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
    const playedWeeks = Object.entries(lineupWeeks ?? {})
      .filter(([week, snapshot]) => Number(week) <= lastRegularSeasonWeek && snapshot.source === 'played')
      .map(([, snapshot]) => snapshot.teams);
    if (!playedWeeks.length) return '<p>No completed lineup scores available.</p>';

    const leagueTeams = [...teams.values()];
    const contenders = leagueTeams.filter(team => winRate(team) > 0.2);
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const rows = lineupSlotLabels.map((label, index) => {
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
    return table(columnHeaders(['Slot', 'AVG', 'Contending AVG', 'League AVG']), rows);
  }

  function leagueTeams() {
    const team = teams.get(state.team);
    const showLineups = state.teamSection === 'Lineups';
    const savedLineup = showLineups ? lineupWeeks?.[state.lineupWeek]?.teams?.[state.team] : null;
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
      ${savedLineup?.length ? table(columnHeaders(['Slot', 'Player', 'PTS']),
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

  let deviationPercent = defaultDeviationPercent;
  let playoffResults;
  let draftResults;
  let projectedPickOwner = 'all';
  let draftDeviation = defaultDeviationPercent;
  let finishView = 'regular';
  const scoreOverrides = new Map();
  let overridesEnabled = false;
  let overridesOpen = false;

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

  function simulatePlayoffs(draftOrder = false) {
    const deviation = draftOrder ? draftDeviation : deviationPercent;
    const useOverrides = !draftOrder && overridesEnabled;
    const {schedule, medianGame} = data.playoffModel;
    // Resolve projections and any fixed scores once before running the trials.
    const weeklyGames = schedule.map((games, index) => {
      const week = data.medianModel.lastScored + 1 + index;
      return games.map(game => game.map(id => {
        const mean = playoffMean(week, id);
        const finalized = scoreFinalized(week, id);
        const override = useOverrides && !finalized ? scoreOverrides.get(`${week}:${id}`) : undefined;
        return {id, mean, fixed:override ?? (finalized ? Math.round(mean * 100) : undefined)};
      }));
    });
    const playoffMeans = Array.from({length:3}, (_, round) => new Map(data.teams.map(team =>
      [team.id, playoffMean(data.medianModel.playoffStart + round, team.id)])));
    const {counts, ...results} = simulateSeason({
      leagueTeams: data.teams, weeklyGames, playoffMeans, medianGame, deviation, draftOrder,
    });
    const rows = [...teams.values()].sort(compareStandings).map(team => counts.get(team.id));
    return {...results, rows};
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

  const finishDistributions = {
    regular: {field:'finishes', total:trialCount},
    postseason: {field:'postseasonFinishes', total:postseasonTrialCount},
  };

  function probabilityHeatmap({title, rows, distribution: {field, total}, controls = ''}) {
    const heading = `<h3>${html(title)}</h3>`;
    const positions = Array.from({length:teams.size}, (_, index) =>
      `<div class="finish-position">${index + 1}</div>`).join('');
    const lowColor = [48, 55, 53];
    const highColor = [214, 248, 134];
    const heatRows = rows.map(row => {
      const teamName = name(row.id);
      const counts = row[field];
      const mostLikely = counts.indexOf(Math.max(...counts));
      const cells = counts.map((count, index) => {
        // The square-root scale makes low probabilities easier to distinguish by color.
        const intensity = Math.sqrt(count / total);
        const color = lowColor.map((channel, i) =>
          Math.round(channel + (highColor[i] - channel) * intensity));
        const chance = percent(count, total);
        const label = html(`${teamName}, position ${index + 1}, ${chance}`);
        const emphasis = index === mostLikely ? 'color:#000;font-weight:700' : 'color:#fff';
        return `<div class="finish-cell" title="${label}" style="background-color:rgb(${color.join(',')});${emphasis}">${chance}</div>`;
      }).join('');
      return `<div class="finish-team">${html(teamName)}</div>${cells}`;
    }).join('');
    return `<section class="analytics finish-heatmap">
      ${controls ? `<div class="heading">${heading}${controls}</div>` : heading}
      <div class="finish-scroll"><div class="finish-grid" style="grid-template-columns:11rem repeat(${teams.size}, 3.5rem)">
        <div></div>${positions}${heatRows}
      </div></div>
    </section>`;
  }

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
        : draftResults ? `${projectedOwnershipBoard(year)}${probabilityHeatmap({
          title:'Draft position probabilities', rows:draftResults.rows, distribution:finishDistributions.postseason,
        })}` : ''}
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
        ${probabilityHeatmap({
          title:'Finish probabilities', rows:playoffResults.rows,
          distribution:finishView === 'postseason' ? finishDistributions.postseason : finishDistributions.regular,
          controls:select('Season stage', 'finishView', [['regular','Regular season'], ['postseason','Postseason']], finishView),
        })}
        <section class="analytics"><dl class="metrics">
        <div class="card"><dt>Projected Playoff Cutoff</dt><dd>${cutoffRecord(playoffResults.cutoffs.playoff)}</dd></div>
        <div class="card"><dt>Projected Bye Cutoff</dt><dd>${cutoffRecord(playoffResults.cutoffs.bye)}</dd></div>
        </dl><p>Average records of the 6th and 2nd seeds across all trials. Ties count as half a win and half a loss.</p></section>`
        : '<p>Run the simulation to see estimated probabilities.</p>'}`;
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
    content.innerHTML = {standings, matchups, teams:leagueTeams, draft, playoffs, methodology}[state.view]();
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
  startDashboard(useCached ? cached : published);
  if (useCached) syncStatus.textContent = 'Synced for this tab.';
  syncButton.disabled = false;
  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    syncStatus.textContent = 'Syncing…';
    try {
      const payload = await syncSleeper();
      const snapshots = JSON.parse(payload);
      const view = document.querySelector('[data-view][aria-current="page"]')?.dataset.view;
      startDashboard(snapshots, view);
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
