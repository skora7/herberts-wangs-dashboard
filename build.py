"""Build a static Dynasty Dashboard from Sleeper's read-only API."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from statistics import variance
from urllib.request import urlopen

LEAGUE_ID = "1312004884693807104"
SLEEPER_USERNAME = "skora"
ROOT = Path(__file__).resolve().parent
LINEUP_SLOTS = (
    ("QB", ("QB",)),
    ("RB", ("RB",)),
    ("RB", ("RB",)),
    ("WR", ("WR",)),
    ("WR", ("WR",)),
    ("TE", ("TE",)),
    ("WRT", ("WR", "RB", "TE")),
    ("WRT", ("WR", "RB", "TE")),
    ("WRTQ", ("WR", "RB", "TE", "QB")),
)


def fetch(path):
    with urlopen(f"https://api.sleeper.app/{path}", timeout=30) as response:
        return json.load(response)


def score(settings, field):
    return settings.get(field, 0) + (settings.get(f"{field}_decimal") or 0) / 100


def matchup_points(row):
    override = row.get("custom_points")
    return override if override is not None else row.get("points")


def finished_starter_points(row, players, finished_teams):
    starter_points = row.get("starters_points") or []
    player_points = row.get("players_points") or {}
    return sum(
        (starter_points[index] if index < len(starter_points) and starter_points[index] is not None
         else player_points.get(player_id)) or 0
        for index, player_id in enumerate(row.get("starters") or [])
        if players.get(player_id, {}).get("team") in finished_teams
    )


def current_league():
    league = fetch(f"v1/league/{LEAGUE_ID}")
    first_season = int(league["season"])
    state = fetch("v1/state/nfl")
    latest_season = int(state.get("league_season") or state["season"])
    if latest_season <= first_season:
        return league

    user_id = fetch(f"v1/user/{SLEEPER_USERNAME}")["user_id"]
    for season in range(first_season + 1, latest_season + 1):
        leagues = fetch(f"v1/user/{user_id}/leagues/nfl/{season}")
        successor = next((item for item in leagues
                          if item.get("previous_league_id") == league["league_id"]), None)
        if successor is None:
            break
        league = successor
    return league


def build_roster(roster, players, season_stats):
    unavailable_statuses = {"IR", "PUP", "SUS", "SUSPENDED"}
    ranked = []
    for player_id in roster.get("players") or []:
        player = players.get(player_id, {})
        stats = season_stats.get(player_id, {})
        position = player.get("position")
        positions = player.get("fantasy_positions") or [position]
        total = stats.get("pts_ppr")
        games = stats.get("gp") or 0
        rank = stats.get("pos_rank_ppr")
        injury_status = (player.get("injury_status") or "").upper()
        ranked.append((player_id, positions, injury_status, {
            "name": player.get("full_name") or player_id,
            "rank": f"{position}{rank}" if position and rank else None,
            "total": total,
            "average": total / games if total is not None and games else None,
        }))

    def by_average(entry):
        player = entry[3]
        average = player["average"]
        return (average is None, -(average if average is not None else 0), player["name"].casefold(), entry[0])

    remaining = sorted(ranked, key=by_average)
    lineup = []
    for slot, eligible in LINEUP_SLOTS:
        index = next((index for index, (_, positions, injury_status, _) in enumerate(remaining)
                      if injury_status not in unavailable_statuses and any(pos in eligible for pos in positions)), None)
        player = remaining.pop(index)[3] if index is not None else None
        lineup.append({"slot": slot, "player": player})
    return lineup, [
        player | {"reserveTag": "SUS" if injury_status == "SUSPENDED" else injury_status}
        if injury_status in unavailable_statuses else player
        for _, _, injury_status, player in remaining
    ]


def build_weekly_lineups(rosters, matchups, players, projections, scoring, actual_slots,
                         locked_teams=(), finished_teams=(), played=False):
    matchup_by_team = {row["roster_id"]: row for row in matchups}
    latest = {}
    for row in projections or []:
        player_id = row["player_id"]
        previous = latest.get(player_id)
        if row.get("category") == "proj" and row.get("stats") and (
            previous is None or (row.get("last_modified") or 0) > (previous.get("last_modified") or 0)
        ):
            latest[player_id] = row
    projected_points = {
        player_id: sum(weight * (row["stats"].get(stat) or 0) for stat, weight in scoring.items())
        for player_id, row in latest.items()
    }
    lineups = {}
    for roster_id, roster in rosters.items():
        matchup = matchup_by_team.get(roster_id, {})
        starter_points = matchup.get("starters_points") or []
        player_points = matchup.get("players_points") or {}
        actual_points = {}
        for index, player_id in enumerate(matchup.get("starters") or []):
            if player_id and player_id != "0" and (
                played or players.get(player_id, {}).get("team") in finished_teams
            ):
                actual = starter_points[index] if index < len(starter_points) else None
                actual_points[player_id] = actual if actual is not None else player_points.get(player_id)

        if played:
            original = [pid if pid and pid != "0" else None
                        for pid in ((matchup.get("starters") or []) + [None] * len(actual_slots))[:len(actual_slots)]]
            remaining = sorted(
                (pid for pid in original if pid),
                key=lambda pid: (pid not in projected_points, -projected_points.get(pid, 0)),
            )
            ordered = []
            for _, eligible in LINEUP_SLOTS:
                index = next((i for i, pid in enumerate(remaining)
                              if any(pos in eligible for pos in (
                                  players.get(pid, {}).get("fantasy_positions")
                                  or [players.get(pid, {}).get("position")]))), None)
                ordered.append(remaining.pop(index) if index is not None else None)
            # Preserve every actual starter if positions are unknown or greedy assignment gets stuck.
            if remaining or tuple(actual_slots) != tuple(slot for slot, _ in LINEUP_SLOTS):
                ordered = original
            lineups[roster_id] = [{"slot": slot, "playerId": pid,
                                   "actualPoints": actual_points.get(pid),
                                   "pregamePoints": projected_points.get(pid, 0)}
                                  for slot, pid in zip(actual_slots, ordered)]
            continue
        locked = {}
        for index, player_id in enumerate((matchup.get("starters") or [])[:len(LINEUP_SLOTS)]):
            nfl_team = players.get(player_id, {}).get("team")
            if nfl_team in locked_teams:
                points = projected_points.get(player_id)
                if nfl_team in finished_teams:
                    points = actual_points.get(player_id)
                locked[index] = (player_id, (), points)
        candidates = []
        for player_id in roster:
            player = players.get(player_id, {})
            points = projected_points.get(player_id, 0)
            if points > 0 and player.get("team") not in locked_teams:
                positions = player.get("fantasy_positions") or [player.get("position")]
                candidates.append((player_id, positions, points))
        candidates.sort(key=lambda player: (-player[2], player[0]))
        assigned = {}

        def place(candidate, visited):
            eligible_slots = [index for index, (_, eligible) in enumerate(LINEUP_SLOTS)
                              if index not in locked and index not in visited
                              and any(position in eligible for position in candidate[1])]
            for index in eligible_slots:
                if index not in assigned:
                    assigned[index] = candidate
                    return True
            for index in eligible_slots:
                if index in visited:
                    continue
                visited.add(index)
                if place(assigned[index], visited):
                    assigned[index] = candidate
                    return True
            return False

        # Highest projections first, moving flexible players when that makes room.
        for candidate in candidates:
            place(candidate, set())
        assigned.update(locked)
        lineups[roster_id] = [
            {"slot": slot, "playerId": player_id, "projectedPoints": points,
             "actualPoints": actual_points.get(player_id),
             "pregamePoints": projected_points.get(player_id, 0)}
            for index, (slot, _) in enumerate(LINEUP_SLOTS)
            for player_id, _, points in [assigned.get(index, (None, (), 0))]
        ]
    return lineups


def load_league():
    league = current_league()
    prefix = f"v1/league/{league['league_id']}"
    season = int(league["season"])
    league_settings = league["settings"]
    last_week = league_settings.get("leg") or 1
    playoff_start = league_settings.get("playoff_week_start") or 0
    last_scored = league_settings.get("last_scored_leg") or 0
    first_week = league_settings.get("start_week") or 1
    matchup_weeks = range(first_week, max(last_week + 1, playoff_start, 15))
    requests = {
        "users": f"{prefix}/users",
        "rosters": f"{prefix}/rosters",
        "picks": f"{prefix}/traded_picks",
        "players": "v1/players/nfl",
        "stats": f"stats/nfl/{season}?season_type=regular",
        **{week: f"{prefix}/matchups/{week}" for week in matchup_weeks},
    }
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = dict(zip(requests, pool.map(fetch, requests.values())))

    owners = {user["user_id"]: user for user in results["users"]}
    players = results["players"]
    season_stats = {row["player_id"]: row.get("stats") or {} for row in results["stats"]}
    median_game = bool(league_settings.get("league_average_match"))
    results_per_week = 2 if median_game else 1
    history = {}
    for week in range(first_week, min(last_scored + 1, playoff_start or last_week + 1)):
        for row in results[week]:
            points = matchup_points(row)
            if row.get("matchup_id") is not None and points is not None:
                history.setdefault(row["roster_id"], []).append(points)
    teams = []
    for roster in results["rosters"]:
        owner = owners.get(roster.get("owner_id"), {})
        settings = roster["settings"]
        lineup, bench = build_roster(roster, players, season_stats)
        wins, losses, ties = (settings.get(field, 0) for field in ("wins", "losses", "ties"))
        completed_weeks = (wins + losses + ties) // results_per_week
        points_for = score(settings, "fpts")
        weekly_points = history.get(roster["roster_id"], [])
        starter_averages = [player["average"] for row in lineup
                            if (player := row["player"]) is not None and player["average"] is not None]
        teams.append({
            "id": roster["roster_id"],
            "name": (owner.get("metadata") or {}).get("team_name")
            or owner.get("display_name") or f"Team {roster['roster_id']}",
            "wins": wins,
            "losses": losses,
            "ties": ties,
            "pf": points_for,
            "pa": score(settings, "fpts_against"),
            "lineup": lineup,
            "bench": bench,
            "analytics": {
                "average": points_for / completed_weeks if completed_weeks else None,
                "starterAverage": sum(starter_averages) if starter_averages else None,
                "variance": variance(weekly_points) if len(weekly_points) >= 2 else None,
            },
        })

    weeks = {}
    remaining = []
    schedule = fetch(f"schedule/nfl/regular/{season}") if last_scored < last_week and last_week <= 17 else []
    current_games = [game for game in schedule if int(game["week"]) == last_week]
    if last_scored < last_week <= 17 and not current_games:
        raise ValueError(f"Missing NFL schedule for week {last_week}")
    current_week_finished = last_week <= last_scored or bool(current_games) and all(
        game["status"] == "complete" for game in current_games
    )
    finished_teams = {game[side] for game in current_games if game["status"] == "complete"
                      for side in ("home", "away")}
    for week in matchup_weeks:
        groups = {}
        for row in results[week]:
            matchup = row.get("matchup_id")
            if matchup is not None:
                result = {"id": row["roster_id"], "points": matchup_points(row)}
                if week > last_week:
                    result["points"] = 0
                elif week == last_week and not current_week_finished and week <= 14:
                    result["points"] = finished_starter_points(row, players, finished_teams)
                groups.setdefault(matchup, []).append(result)
        if groups:
            weeks[week] = list(groups.values())
        if last_scored < week < playoff_start:
            remaining.append([[team["id"] for team in game] for game in groups.values()])

    rounds = league["settings"].get("draft_rounds") or 0
    trades = {(int(p["season"]), p["round"], p["roster_id"]): p["owner_id"]
              for p in results["picks"]}
    picks = []
    for year in range(season + 1, season + 4):
        for team in teams:
            for round_number in range(1, rounds + 1):
                owner = trades.get((year, round_number, team["id"]), team["id"])
                picks.append({"year": year, "round": round_number, "original": team["id"], "owner": owner})

    median_inputs = {}
    rosters = {row["roster_id"]: row.get("players") or [] for row in results["rosters"]}
    rostered = {player for roster in rosters.values() for player in roster}
    projection_players = {week: rostered for week in range(last_week + 1, 18)}
    if not current_week_finished and last_week <= 17:
        projection_players[last_week] = rostered
    if median_game:
        forecast_weeks = [week for week in weeks if last_scored < week < playoff_start and week <= last_week]
        if forecast_weeks:
            schedule = schedule or fetch(f"schedule/nfl/regular/{season}")
            for week in forecast_weeks:
                matchups = [
                    {key: row.get(key) for key in (
                        "roster_id", "matchup_id", "points", "custom_points", "starters", "starters_points", "players_points",
                    )}
                    for row in results[week] if row.get("matchup_id") is not None
                ]
                starters = {player for row in matchups for player in (row["starters"] or [])}
                games = [game for game in schedule if int(game["week"]) == week]
                if not games or len({row["roster_id"] for row in matchups}) != len(teams):
                    raise ValueError(f"Incomplete median inputs for week {week}")
                if any(game["status"] != "complete" for game in games):
                    projection_players[week] = rostered | (starters - {"0", None})
                median_inputs[week] = {"matchups": matchups, "schedule": games}

    projection_weeks = {}
    played_weeks = {week for week in results if isinstance(week, int)
                    and (week < last_week or (week == last_week and current_week_finished))}
    historical_players = {week: {pid for row in results[week] for pid in (row.get("starters") or [])
                                  if pid and pid != "0"} for week in played_weeks}
    for week in sorted(projection_players.keys() | historical_players.keys()):
        player_ids = projection_players.get(week, set()) | historical_players.get(week, set())
        if not player_ids:
            continue
        rows = fetch(f"projections/nfl/{season}/{week}?season_type=regular")
        projection_weeks[week] = [
            {key: row.get(key) for key in (
                "player_id", "company", "category", "game_id", "last_modified", "stats",
            )} | {"player": {"position": (row.get("player") or {}).get("position")}}
            for row in rows if row.get("company") == "rotowire" and row.get("player_id") in player_ids
        ]
        if not projection_weeks[week] and week in projection_players:
            raise ValueError(f"Missing RotoWire projections for week {week}")

    slot_names = {"FLEX": "WRT", "SUPER_FLEX": "WRTQ"}
    actual_slots = [slot_names.get(slot, slot) for slot in league["roster_positions"] if slot != "BN"]
    locked_teams = {game[side] for game in current_games if game["status"] != "pre_game"
                    for side in ("home", "away")}
    weekly_lineups = {
        week: {
            "source": "played" if week < last_week or (week == last_week and current_week_finished)
            else "projected",
            "teams": build_weekly_lineups(
                rosters, results.get(week, []), players,
                projection_weeks.get(week),
                league["scoring_settings"], actual_slots,
                locked_teams if week == last_week else (), finished_teams if week == last_week else (),
                played=week < last_week or (week == last_week and current_week_finished),
            ),
        }
        for week in range(1, 18)
    }
    lineup_player_ids = {slot["playerId"] for week in weekly_lineups.values()
                         for lineup in week["teams"].values() for slot in lineup if slot["playerId"]}
    lineup_players = {player_id: players.get(player_id, {}).get("full_name") or player_id
                      for player_id in sorted(lineup_player_ids)}
    return {
        "name": league["name"], "season": season, "teams": teams, "weeks": weeks,
        "currentWeek": last_week,
        "currentWeekFinished": current_week_finished,
        "picks": picks,
        "medianModel": {
            "inputs": median_inputs,
            "lastScored": last_scored,
            "playoffStart": playoff_start,
            "scoring": league["scoring_settings"],
            "players": {
                player_id: [players[player_id].get("team"), players[player_id].get("position")]
                for roster in results["rosters"] for player_id in (roster.get("players") or [])
                if player_id in players
            },
        },
        "playoffModel": {
            "schedule": remaining,
            "medianGame": median_game,
            "reseed": league_settings.get("playoff_seed_type") == 1,
            "supported": bool(playoff_start and last_week <= playoff_start
                              and league_settings.get("playoff_teams") == 6
                              and not league_settings.get("playoff_round_type")
                              and not any(roster["settings"].get("division") for roster in results["rosters"])),
        },
        "updated": datetime.now(UTC).isoformat(timespec="seconds"),
    }, {"season": season, "weeks": projection_weeks}, {
        "season": season, "currentWeek": last_week, "players": lineup_players, "weeks": weekly_lineups,
    }


def main():
    league, projections, lineups = load_league()
    snapshots = {"sleeper.json": league, "projections.json": projections, "lineups.json": lineups}
    staged = {}
    try:
        for filename, data in snapshots.items():
            output = ROOT / filename
            temporary = output.with_suffix(".tmp")
            staged[output] = temporary
            payload = json.dumps(data, ensure_ascii=False, allow_nan=False)
            temporary.write_text(payload + "\n", encoding="utf-8")
        for output, temporary in staged.items():
            temporary.replace(output)
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
    print(f"Built three snapshots for {league['name']} ({len(league['teams'])} teams, {len(league['weeks'])} weeks)")


if __name__ == "__main__":
    main()
