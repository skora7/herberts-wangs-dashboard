export const medianTrialCount = 10_000;
export const trialCount = 50_000;
export const postseasonsPerTrial = 3;
export const postseasonTrialCount = trialCount * postseasonsPerTrial;

// Box–Muller transform shared by the median and season simulations.
function normalDraw() {
  const radius = Math.sqrt(-2 * Math.log(1 - Math.random()));
  return radius * Math.cos(2 * Math.PI * Math.random());
}

export function sampleMedian(lineups) {
  const results = new Map(lineups.map(team => [team.id, {score:0, median:0, win:0}]));
  const trials = lineups.some(team => team.players.length) ? medianTrialCount : 1;
  for (let trial = 0; trial < trials; trial++) {
    const scores = lineups.map(team => {
      const score = team.players.reduce((total, player) => total + player.mean + player.sd * normalDraw(), team.fixed);
      return {id:team.id, score:Math.round(score * 100)};
    }).sort((a,b) => a.score - b.score);
    const middle = scores.length / 2;
    // Excluding one team leaves one of the two middle scores as the median.
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

export function simulateSeason({leagueTeams, weeklyGames, playoffMeans, medianGame, deviation, draftOrder}) {
  const counts = new Map(leagueTeams.map(team => [team.id, {
    id:team.id, champion:0, bye:0, qualified:0, winRate:0,
    finishes:Array(leagueTeams.length).fill(0), postseasonFinishes:Array(leagueTeams.length).fill(0),
  }]));
  const k = deviation / 100;
  const remainingGames = weeklyGames.length * (medianGame ? 2 : 1);
  const cutoffs = {playoff:0, bye:0};
  function draw(mean) {
    return Math.max(0, Math.round((mean + normalDraw() * k * mean) * 100));
  }

  for (let trial = 0; trial < trialCount; trial++) {
    const standings = new Map(leagueTeams.map(team => [team.id, {
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
      if (medianGame) {
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
    // Reuse the regular-season seeds for independent bracket simulations.
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
  const {wins, losses, ties} = leagueTeams[0];
  const games = wins + losses + ties + remainingGames;
  return {counts, cutoffs, games, deviationPercent:deviation};
}
