// =============================================================
// score.js - Algorithme CZF Score v4
// =============================================================

const { getRankedByPuuid, getMatchIds, getMatchDetail } = require('./riot');

const TIER_MMR = {
  IRON: 200, BRONZE: 600, SILVER: 1000, GOLD: 1400,
  PLATINUM: 1800, EMERALD: 2200, DIAMOND: 2600,
  MASTER: 3000, GRANDMASTER: 3200, CHALLENGER: 3400
};
const RANK_MMR = { IV: 0, III: 100, II: 200, I: 300 };

const ROLE_BENCH = {
  BOTTOM:  { dmgPerMin: 620, csPerMin: 7.5, visionPerMin: 1.1, teamDmgPct: 0.26, earlyCS: 72 },
  MIDDLE:  { dmgPerMin: 580, csPerMin: 7.0, visionPerMin: 1.0, teamDmgPct: 0.25, earlyCS: 68 },
  TOP:     { dmgPerMin: 520, csPerMin: 6.8, visionPerMin: 0.9, teamDmgPct: 0.22, earlyCS: 65 },
  JUNGLE:  { dmgPerMin: 450, csPerMin: 5.0, visionPerMin: 1.0, teamDmgPct: 0.20, earlyCS: 30 },
  UTILITY: { dmgPerMin: 250, csPerMin: 1.5, visionPerMin: 1.6, teamDmgPct: 0.10, earlyCS: 20 }
};

const ROLE_LABEL = {
  TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support'
};

function tierToMMR(tier, rank, lp) {
  if (!tier) return 0;
  return (TIER_MMR[tier] || 0) + (RANK_MMR[rank] || 0) + Math.round(lp || 0);
}

function expectedWinRate(playerMMR, lobbyMMR) {
  return 1 / (1 + Math.pow(10, (lobbyMMR - playerMMR) / 400));
}

function norm(val, min, max) {
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

function wavg(arr, field) {
  let sw = 0, w = 0;
  for (const item of arr) {
    const wt = item.weight || 1;
    sw += (item.player ? item.player[field] : item[field]) * wt;
    w  += wt;
  }
  return w > 0 ? sw / w : 0;
}

function consistencyRatio(matches, field) {
  const winVals  = matches.filter(m => m.player.win).map(m => m.player[field]);
  const lossVals = matches.filter(m => !m.player.win).map(m => m.player[field]);
  if (!winVals.length || !lossVals.length) return 0.7;
  const winAvg  = winVals.reduce((a, b) => a + b, 0)  / winVals.length;
  const lossAvg = lossVals.reduce((a, b) => a + b, 0) / lossVals.length;
  return winAvg > 0 ? Math.min(lossAvg / winAvg, 1.0) : 0.5;
}

function extractRankInfo(rankedData) {
  const solo = rankedData.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
  const flex = rankedData.find(e => e.queueType === 'RANKED_FLEX_SR')  || null;
  const entry = solo || flex;
  if (!entry) return { mmr: 0, tier: null, rank: null, lp: 0, wins: 0, losses: 0 };
  return {
    mmr:    tierToMMR(entry.tier, entry.rank, entry.leaguePoints),
    tier:   entry.tier,
    rank:   entry.rank,
    lp:     entry.leaguePoints,
    wins:   entry.wins,
    losses: entry.losses,
    soloEntry: solo,
    flexEntry: flex
  };
}

function extractParticipant(p, duration) {
  const min = Math.max(duration / 60, 1);
  const ch  = p.challenges || {};
  return {
    puuid:    p.puuid,
    champion: p.championName,
    role:     p.teamPosition || 'UNKNOWN',
    teamId:   p.teamId,
    win:      p.win,
    minutes:  min,
    // Mecanique
    soloKills:   ch.soloKills || 0,
    earlyCS:     ch.laneMinionsFirst10Minutes || 0,
    kda:         (p.kills + p.assists * 0.75) / Math.max(p.deaths, 1),
    kills:       p.kills,
    deaths:      p.deaths,
    assists:     p.assists,
    damagePerMin: ch.damagePerMinute || (p.totalDamageDealtToChampions / min),
    // Vision
    visionPerMin: ch.visionScorePerMinute || ((p.visionScore || 0) / min),
    controlWards: p.visionWardsBoughtInGame || 0,
    wardsKilled:  p.wardsKilled || 0,
    quickFirstTurret: ch.quickFirstTurret || 0,
    // Impact
    killParticipation: ch.killParticipation || 0,
    teamDmgPct:        ch.teamDamagePercentage || 0,
    saveAllyFromDeath: ch.saveAllyFromDeath || 0,
    turretTakedowns:   ch.turretTakedowns || 0,
    dragonTakedowns:   ch.dragonTakedowns || 0,
    baronTakedowns:    ch.baronTakedowns  || 0,
    // Efficacite
    goldPerMin:    ch.goldPerMinute || (p.goldEarned / min),
    csPerMin:      (p.totalMinionsKilled + p.neutralMinionsKilled) / min,
    maxCsAdvantage: ch.maxCsAdvantageOnLaneOpponent || 0,
    goldEarned:    p.goldEarned,
  };
}

function detectMainRole(matches) {
  const counts = {};
  for (const m of matches) {
    const r = m.player.role;
    if (r && r !== 'UNKNOWN') counts[r] = (counts[r] || 0) + m.weight;
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'MIDDLE';
}

function getTopChampions(matches) {
  const data = {};
  for (const m of matches) {
    const c = m.player.champion;
    if (!data[c]) data[c] = { wins: 0, games: 0 };
    data[c].games++;
    if (m.player.win) data[c].wins++;
  }
  return Object.keys(data)
    .sort((a, b) => data[b].games - data[a].games)
    .slice(0, 3)
    .map(n => ({ name: n, games: data[n].games, wr: Math.round(data[n].wins / data[n].games * 100) }));
}

function getWrByRole(matches) {
  const data = {};
  for (const m of matches) {
    const r = m.player.role;
    if (!data[r]) data[r] = { wins: 0, games: 0 };
    data[r].games++;
    if (m.player.win) data[r].wins++;
  }
  const result = {};
  for (const r in data) {
    result[r] = { wr: Math.round(data[r].wins / data[r].games * 100), games: data[r].games };
  }
  return result;
}

// ============================================================
// COLLECTE DES DONNEES
// ============================================================

async function collectAllData(playerPuuid, apiKey, maxGames, seasonStart) {
  const rankCache = {};
  const matchIds  = await getMatchIds(playerPuuid, apiKey, maxGames, seasonStart);
  console.log(`${matchIds.length} parties trouvees`);

  const matches = [];

  for (const matchId of matchIds) {
    const detail = await getMatchDetail(matchId, apiKey);
    if (!detail?.info) continue;

    const participants = detail.info.participants;
    const duration     = detail.info.gameDuration;
    const queueId      = detail.info.queueId;

    const playerRaw = participants.find(p => p.puuid === playerPuuid);
    if (!playerRaw) continue;

    const player     = extractParticipant(playerRaw, duration);
    const allyPuuids = participants.filter(p => p.puuid !== playerPuuid && p.teamId === player.teamId).map(p => p.puuid);
    const allPuuids  = participants.map(p => p.puuid);

    matches.push({
      matchId,
      player,
      weight:      queueId === 420 ? 1.0 : 0.7,
      allPuuids,
      allyPuuids,
      queueId,
    });
  }

  console.log(`${matches.length} parties analysees. Prefetch des rangs du lobby...`);

  // Prefetch tous les rangs en parallele (par batch de 5 pour eviter le rate limit)
  const allPuuids = [...new Set(matches.flatMap(m => m.allPuuids).filter(p => p !== playerPuuid))];
  for (let i = 0; i < allPuuids.length; i += 5) {
    const batch = allPuuids.slice(i, i + 5);
    await Promise.all(batch.map(p => getRankedByPuuid(p, apiKey, rankCache)));
  }

  console.log(`Rangs prefetches pour ${Object.keys(rankCache).length} joueurs`);

  return { matches, rankCache };
}

// ============================================================
// ANALYSE LOBBY
// ============================================================

function analyzeLobby(allPuuids, playerPuuid, playerMMR, rankCache) {
  const lobbyMMRs = allPuuids
    .filter(p => p !== playerPuuid && rankCache[p])
    .map(p => {
      const entry = (rankCache[p] || []).find(e => e.queueType === 'RANKED_SOLO_5x5')
                 || (rankCache[p] || []).find(e => e.queueType === 'RANKED_FLEX_SR');
      return entry ? tierToMMR(entry.tier, entry.rank, entry.leaguePoints) : 0;
    })
    .filter(m => m > 0);

  if (!lobbyMMRs.length) return { avgMMR: playerMMR, expectedWR: 0.5, mmrDelta: 0 };

  const avgMMR = lobbyMMRs.reduce((a, b) => a + b, 0) / lobbyMMRs.length;
  return {
    avgMMR:     Math.round(avgMMR),
    expectedWR: expectedWinRate(playerMMR, avgMMR),
    mmrDelta:   Math.round(avgMMR - playerMMR)
  };
}

// ============================================================
// ALGORITHME PRINCIPAL
// ============================================================

function calculate(rankInfo, matches, rankCache) {
  if (!matches || matches.length < 5) {
    return { error: `Pas assez de parties (${matches?.length || 0} min 5)` };
  }

  const mainRole  = detectMainRole(matches);
  const bench     = ROLE_BENCH[mainRole] || ROLE_BENCH.MIDDLE;
  const isSupport = mainRole === 'UTILITY';
  const isJungle  = mainRole === 'JUNGLE';
  const playerMMR = rankInfo.mmr;
  const lossM     = matches.filter(m => !m.player.win);
  const winM      = matches.filter(m =>  m.player.win);

  const wavgP = (field) => {
    let sw = 0, w = 0;
    for (const m of matches) { sw += m.player[field] * m.weight; w += m.weight; }
    return w > 0 ? sw / w : 0;
  };
  const wavgLoss = (field) => {
    if (!lossM.length) return wavgP(field);
    return lossM.reduce((s, m) => s + m.player[field], 0) / lossM.length;
  };

  // AXE 1 - MECANIQUE (18%)
  const avgEarlyCS    = wavgP('earlyCS');
  const csEarlyNorm   = (isJungle || isSupport) ? 0.5 : norm(avgEarlyCS, bench.earlyCS * 0.6, bench.earlyCS * 1.4);
  const soloKillRef   = isSupport ? 0.05 : isJungle ? 0.15 : 0.30;
  const soloKillNorm  = norm(wavgP('soloKills'), 0, soloKillRef * 2.5);
  const dmgLossNorm   = norm(wavgLoss('damagePerMin'), bench.dmgPerMin * 0.4, bench.dmgPerMin * 1.4);
  const kdaNorm       = norm(wavgP('kda'), 0.8, 5.0);
  const scoreA = csEarlyNorm * 0.30 + soloKillNorm * 0.25 + dmgLossNorm * 0.30 + kdaNorm * 0.15;

  // AXE 2 - VISION & MACRO (15%)
  const visionInLoss   = wavgLoss('visionPerMin');
  const visionBoost    = isSupport ? 1.25 : 1.0;
  const turretConv     = matches.filter(m => m.player.quickFirstTurret > 0).length / matches.length;
  const scoreB = (
    norm(visionInLoss, 0, bench.visionPerMin * 1.6) * 0.50 +
    norm(wavgP('controlWards'), 0, isSupport ? 2.8 : 1.6) * 0.30 +
    norm(wavgP('wardsKilled'),  0, isSupport ? 1.5 : 0.9) * 0.20
  ) * visionBoost * 0.80 + turretConv * 0.20;

  // AXE 3 - IMPACT COLLECTIF (17%)
  const kpInWin  = winM.length  ? winM.reduce((s, m)  => s + m.player.killParticipation, 0) / winM.length  : 0;
  const kpInLoss = lossM.length ? lossM.reduce((s, m) => s + m.player.killParticipation, 0) / lossM.length : 0;
  const kpNorm   = norm(kpInLoss, 0.35, 0.75) * 0.60 + norm(kpInWin, 0.45, 0.85) * 0.40;
  const avgObj   = wavgP('turretTakedowns') + wavgP('dragonTakedowns') * 1.5 + wavgP('baronTakedowns') * 2.0;
  const saveNorm = isSupport ? norm(wavgP('saveAllyFromDeath'), 0, 1.5) : norm(wavgP('saveAllyFromDeath'), 0, 0.5);
  const scoreC   = kpNorm * 0.35
    + norm(wavgP('teamDmgPct'), bench.teamDmgPct * 0.5, bench.teamDmgPct * 1.8) * 0.30
    + norm(avgObj, 0, isSupport ? 2.0 : 3.5) * 0.25
    + saveNorm * 0.10;

  // AXE 4 - EFFICACITE ECONOMIQUE (15%)
  const goldRef  = isSupport ? 280 : isJungle ? 380 : 420;
  const scoreD   = norm(wavgLoss('goldPerMin'), goldRef * 0.6, goldRef * 1.5) * 0.40
    + (isSupport ? 0.5 : norm(wavgP('csPerMin'), bench.csPerMin * 0.5, bench.csPerMin * 1.4)) * 0.35
    + (isSupport || isJungle ? 0.5 : norm(wavgP('maxCsAdvantage'), 0, 40)) * 0.25;

  // AXE 5 - PERFORMANCE RELATIVE AU LOBBY (25%)
  let lobbyPerfSum = 0, lobbyWeightSum = 0;
  let totalLobbyMMR = 0, lobbyCount = 0;

  for (const m of matches) {
    const lobby  = analyzeLobby(m.allPuuids, m.player.puuid, playerMMR, rankCache);
    const actual = m.player.win ? 1.0 : 0.0;
    const delta  = actual - lobby.expectedWR;
    const mult   = Math.max(0.5, Math.min(2.0, 1.0 + (lobby.mmrDelta / 400) * 0.3));
    lobbyPerfSum   += delta * mult * m.weight;
    lobbyWeightSum += m.weight;
    if (lobby.avgMMR > 0) { totalLobbyMMR += lobby.avgMMR; lobbyCount++; }
  }

  const avgLobbyPerf = lobbyWeightSum > 0 ? lobbyPerfSum / lobbyWeightSum : 0;
  const scoreE       = norm(avgLobbyPerf + 0.5, 0, 1.0);
  const avgLobbyMMR  = lobbyCount > 0 ? Math.round(totalLobbyMMR / lobbyCount) : playerMMR;

  // AXE 6 - CONSISTANCE (10%)
  const scoreF = consistencyRatio(matches, 'damagePerMin')    * 0.40
               + consistencyRatio(matches, 'killParticipation') * 0.35
               + consistencyRatio(matches, 'visionPerMin')    * 0.25;

  // SCORE FINAL
  let finalScore = Math.pow(
    scoreA * 0.18 + scoreB * 0.15 + scoreC * 0.17 + scoreD * 0.15 + scoreE * 0.25 + scoreF * 0.10,
    0.80
  ) * 20;

  // Soft floor/ceiling selon rang
  const tierIdx = Object.keys(TIER_MMR).indexOf(rankInfo.tier);
  if (tierIdx >= 6) finalScore = Math.max(finalScore, 13.0);
  if (tierIdx === 0) finalScore = Math.min(finalScore, 8.5);

  // Bonus / malus
  const bonusList = [];
  const dmgConsistency = consistencyRatio(matches, 'damagePerMin');
  if (dmgConsistency > 0.80) { finalScore += 0.4; bonusList.push('+0.4 Performance stable meme en losing'); }
  if (avgLobbyPerf > 0.10)   { finalScore += 0.5; bonusList.push('+0.5 Surperforme son niveau de lobby'); }

  const soloGames = matches.filter(m => m.queueId === 420).length;
  if (soloGames < 10) { finalScore -= 0.4; bonusList.push(`-0.4 Peu de parties SoloQ (${soloGames})`); }

  finalScore = Math.round(Math.max(1.0, Math.min(20.0, finalScore)) * 10) / 10;

  const mechScore  = (scoreA * 0.18 + scoreD * 0.15) / 0.33;
  const smurfFlag  = scoreE < 0.35 && mechScore > 0.65;
  const boostedFlag = scoreE > 0.65 && mechScore < 0.30;

  const wr = Math.round(matches.filter(m => m.player.win).length / matches.length * 100);

  return {
    score:      finalScore,
    breakdown: {
      mecanique:   Math.round(scoreA * 20 * 10) / 10,
      vision:      Math.round(scoreB * 20 * 10) / 10,
      impact:      Math.round(scoreC * 20 * 10) / 10,
      efficacite:  Math.round(scoreD * 20 * 10) / 10,
      lobby:       Math.round(scoreE * 20 * 10) / 10,
      consistance: Math.round(scoreF * 20 * 10) / 10,
    },
    stats: {
      games:        matches.length,
      soloGames,
      wr,
      kda:          Math.round(wavgP('kda') * 100) / 100,
      dmgPerMin:    Math.round(wavgP('damagePerMin')),
      csPerMin:     Math.round(wavgP('csPerMin') * 10) / 10,
      visionPerMin: Math.round(wavgP('visionPerMin') * 100) / 100,
      kp:           Math.round(wavgP('killParticipation') * 100),
      mainRole,
      topChampions: getTopChampions(matches),
      wrByRole:     getWrByRole(matches),
      avgLobbyMMR,
      playerMMR,
    },
    bonusList,
    smurfFlag,
    boostedFlag,
    rankInfo,
  };
}

module.exports = { collectAllData, calculate, extractRankInfo, getRankedByPuuid };
