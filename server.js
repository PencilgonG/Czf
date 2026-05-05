// =============================================================
// server.js - CZF Score Bot (tout-en-un)
// =============================================================

const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const RIOT_API_KEY      = process.env.RIOT_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID    = process.env.DISCORD_APP_ID;
const DISCORD_WEBHOOK_SCORES = process.env.DISCORD_WEBHOOK_SCORES || '';
const SECRET_KEY        = process.env.SECRET_KEY || 'czf-secret-2025';
const CF_ACCOUNT_ID     = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE   = process.env.CF_KV_NAMESPACE;
const CF_KV_TOKEN       = process.env.CF_KV_TOKEN;

// SEASON_START : debut du split actuel (a mettre a jour a chaque nouveau split)
// Split 1 2025 : 9 janvier 2025 = 1736380800
// Pour changer : modifier SEASON_START dans les variables d'environnement Render
const SEASON_START = parseInt(process.env.SEASON_START || '1736380800');
const MAX_GAMES    = 500;
const PLATFORM     = 'euw1';
const REGION       = 'europe';
const DELAY_MS     = 1200;

// Cache en memoire : 1 analyse par compte (reset si Render redémarre)
const analysisCache = new Map();
const TEST_ACCOUNT  = 'pencilgon#gang'; // Seul compte reanalysable a volonte

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Secret-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// CONSTANTES
// ============================================================

const TIER_MMR = {
  IRON: 200, BRONZE: 600, SILVER: 1000, GOLD: 1400,
  PLATINUM: 1800, EMERALD: 2200, DIAMOND: 2600,
  MASTER: 3000, GRANDMASTER: 3200, CHALLENGER: 3400
};
const RANK_MMR  = { IV: 0, III: 100, II: 200, I: 300 };
const ROLE_BENCH = {
  BOTTOM:  { dmgPerMin: 620, csPerMin: 7.5, visionPerMin: 1.1, teamDmgPct: 0.26, earlyCS: 72 },
  MIDDLE:  { dmgPerMin: 580, csPerMin: 7.0, visionPerMin: 1.0, teamDmgPct: 0.25, earlyCS: 68 },
  TOP:     { dmgPerMin: 520, csPerMin: 6.8, visionPerMin: 0.9, teamDmgPct: 0.22, earlyCS: 65 },
  JUNGLE:  { dmgPerMin: 450, csPerMin: 5.0, visionPerMin: 1.0, teamDmgPct: 0.20, earlyCS: 30 },
  UTILITY: { dmgPerMin: 250, csPerMin: 1.5, visionPerMin: 1.6, teamDmgPct: 0.10, earlyCS: 20 }
};
const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

// ============================================================
// HELPERS
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tierToMMR(tier, rank, lp) {
  if (!tier) return 0;
  return (TIER_MMR[tier] || 0) + (RANK_MMR[rank] || 0) + Math.round(lp || 0);
}

function expectedWR(playerMMR, lobbyMMR) {
  return 1 / (1 + Math.pow(10, (lobbyMMR - playerMMR) / 400));
}

function norm(val, min, max) {
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

function consistencyRatio(matches, field) {
  const w = matches.filter(m => m.player.win).map(m => m.player[field]);
  const l = matches.filter(m => !m.player.win).map(m => m.player[field]);
  if (!w.length || !l.length) return 0.7;
  const wa = w.reduce((a, b) => a + b, 0) / w.length;
  const la = l.reduce((a, b) => a + b, 0) / l.length;
  return wa > 0 ? Math.min(la / wa, 1.0) : 0.5;
}

function extractRankInfo(data) {
  const solo  = (data || []).find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
  const flex  = (data || []).find(e => e.queueType === 'RANKED_FLEX_SR')  || null;
  const entry = solo || flex;
  if (!entry) return { mmr: 0, tier: null, rank: null, lp: 0, wins: 0, losses: 0 };
  return {
    mmr:    tierToMMR(entry.tier, entry.rank, entry.leaguePoints),
    tier:   entry.tier,
    rank:   entry.rank,
    lp:     entry.leaguePoints,
    wins:   entry.wins,
    losses: entry.losses
  };
}

// ============================================================
// RIOT API
// ============================================================

async function riotGet(url, retries = 0) {
  if (retries > 5) { console.log(`Max retries atteint: ${url.substring(0, 80)}`); return null; }
  await sleep(DELAY_MS);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); // timeout 10s
    const res = await fetch(url, {
      headers: { 'X-Riot-Token': RIOT_API_KEY },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.status === 429) {
      console.log('Rate limit - attente 15s...');
      await sleep(15000);
      return riotGet(url, retries + 1);
    }
    if (res.status === 503 || res.status === 504) {
      console.log(`Serveur Riot ${res.status} - retry dans 5s...`);
      await sleep(5000);
      return riotGet(url, retries + 1);
    }
    if (res.status !== 200) {
      console.log(`API ${res.status}: ${url.substring(0, 80)}`);
      return null;
    }
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log(`Timeout (${retries + 1}/5) - retry: ${url.substring(0, 80)}`);
      await sleep(3000);
      return riotGet(url, retries + 1);
    }
    console.log(`Erreur fetch: ${e.message}`);
    return null;
  }
}

async function getAccount(gameName, tagLine) {
  return riotGet(`https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
}

async function getRanked(puuid, cache) {
  if (cache[puuid] !== undefined) return cache[puuid];
  const data = await riotGet(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`) || [];
  cache[puuid] = data;
  return data;
}

async function getMatchIds(puuid) {
  const ids  = [];
  let start  = 0;
  const batch = 100; // Max autorise par Riot

  // Paginer toutes les parties soloQ de la saison
  while (true) {
    const page = await riotGet(
      `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`
      + `?queue=420&start=${start}&count=${batch}&startTime=${SEASON_START}`
    ) || [];
    for (const id of page) ids.push(id);
    if (page.length < batch) break;
    start += batch;
  }

  // Completer avec du flex seulement si tres peu de soloQ
  if (ids.length < 20) {
    let flexStart = 0;
    while (true) {
      const page = await riotGet(
        `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`
        + `?queue=440&start=${flexStart}&count=${batch}&startTime=${SEASON_START}`
      ) || [];
      for (const id of page) ids.push(id);
      if (page.length < batch) break;
      flexStart += batch;
    }
  }

  console.log(`${ids.length} parties trouvees au total`);
  return ids;
}

async function getMatch(matchId) {
  return riotGet(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
}

// ============================================================
// EXTRACTION STATS
// ============================================================

function extractPlayer(p, duration) {
  const min = Math.max(duration / 60, 1);
  const ch  = p.challenges || {};
  return {
    puuid:    p.puuid,
    champion: p.championName,
    role:     p.teamPosition || 'UNKNOWN',
    teamId:   p.teamId,
    win:      p.win,
    minutes:  min,
    soloKills:          ch.soloKills || 0,
    earlyCS:            ch.laneMinionsFirst10Minutes || 0,
    kda:                (p.kills + p.assists * 0.75) / Math.max(p.deaths, 1),
    damagePerMin:       ch.damagePerMinute || (p.totalDamageDealtToChampions / min),
    visionPerMin:       ch.visionScorePerMinute || ((p.visionScore || 0) / min),
    controlWards:       p.visionWardsBoughtInGame || 0,
    wardsKilled:        p.wardsKilled || 0,
    quickFirstTurret:   ch.quickFirstTurret || 0,
    killParticipation:  ch.killParticipation || 0,
    teamDmgPct:         ch.teamDamagePercentage || 0,
    saveAllyFromDeath:  ch.saveAllyFromDeath || 0,
    turretTakedowns:    ch.turretTakedowns || 0,
    dragonTakedowns:    ch.dragonTakedowns || 0,
    baronTakedowns:     ch.baronTakedowns  || 0,
    goldPerMin:         ch.goldPerMinute || (p.goldEarned / min),
    csPerMin:           (p.totalMinionsKilled + p.neutralMinionsKilled) / min,
    maxCsAdvantage:     ch.maxCsAdvantageOnLaneOpponent || 0,
  };
}

// ============================================================
// COLLECTE
// ============================================================

async function collectAll(playerPuuid) {
  const cache    = {};
  const matchIds = await getMatchIds(playerPuuid);
  console.log(`${matchIds.length} parties trouvees`);

  // Recuperer le rang du joueur en premier
  await getRanked(playerPuuid, cache);

  const matches = [];
  for (const id of matchIds) {
    const detail = await getMatch(id);
    if (!detail?.info) continue;
    const parts    = detail.info.participants;
    const duration = detail.info.gameDuration;
    const queueId  = detail.info.queueId;
    const raw      = parts.find(p => p.puuid === playerPuuid);
    if (!raw) continue;
    const player = extractPlayer(raw, duration);
    matches.push({
      player,
      weight:     queueId === 420 ? 1.0 : 0.7,
      allPuuids:  parts.map(p => p.puuid),
      queueId,
    });
  }

  console.log(`${matches.length} parties analysees. Prefetch lobbies...`);

  // Prefetch rangs de tous les joueurs des lobbies (sequentiel pour respecter le rate limit)
  const allPuuids = [...new Set(matches.flatMap(m => m.allPuuids).filter(p => p !== playerPuuid))];
  console.log(`${allPuuids.length} joueurs uniques a prefetch...`);
  for (let i = 0; i < allPuuids.length; i++) {
    await getRanked(allPuuids[i], cache);
    if (i > 0 && i % 50 === 0) console.log(`Prefetch: ${i}/${allPuuids.length} joueurs...`);
  }

  console.log(`Rangs prefetches: ${Object.keys(cache).length} joueurs`);
  return { matches, cache };
}

// ============================================================
// ALGORITHME CZF SCORE V4
// ============================================================

function calculate(rankInfo, matches, cache) {
  if (!matches || matches.length < 5) {
    return { error: `Pas assez de parties (${matches?.length || 0}, min 5)` };
  }

  const mainRole  = (() => {
    const c = {};
    for (const m of matches) {
      const r = m.player.role;
      if (r && r !== 'UNKNOWN') c[r] = (c[r] || 0) + m.weight;
    }
    return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || 'MIDDLE';
  })();

  const bench     = ROLE_BENCH[mainRole] || ROLE_BENCH.MIDDLE;
  const isSupport = mainRole === 'UTILITY';
  const isJungle  = mainRole === 'JUNGLE';
  const playerMMR = rankInfo.mmr;

  const lossM = matches.filter(m => !m.player.win);
  const winM  = matches.filter(m =>  m.player.win);

  const wavg = field => {
    let sw = 0, w = 0;
    for (const m of matches) { sw += m.player[field] * m.weight; w += m.weight; }
    return w > 0 ? sw / w : 0;
  };
  const wavgLoss = field => {
    if (!lossM.length) return wavg(field);
    return lossM.reduce((s, m) => s + m.player[field], 0) / lossM.length;
  };

  // AXE 1 - MECANIQUE (18%)
  const csEarlyNorm  = (isJungle || isSupport) ? 0.5 : norm(wavg('earlyCS'), bench.earlyCS * 0.6, bench.earlyCS * 1.4);
  const soloKillRef  = isSupport ? 0.05 : isJungle ? 0.15 : 0.30;
  const scoreA = csEarlyNorm * 0.30
    + norm(wavg('soloKills'), 0, soloKillRef * 2.5) * 0.25
    + norm(wavgLoss('damagePerMin'), bench.dmgPerMin * 0.4, bench.dmgPerMin * 1.4) * 0.30
    + norm(wavg('kda'), 0.8, 5.0) * 0.15;

  // AXE 2 - VISION & MACRO (15%)
  const visionBoost  = isSupport ? 1.25 : 1.0;
  const turretConv   = matches.filter(m => m.player.quickFirstTurret > 0).length / matches.length;
  const scoreB = (
    norm(wavgLoss('visionPerMin'), 0, bench.visionPerMin * 1.6) * 0.50 +
    norm(wavg('controlWards'),  0, isSupport ? 2.8 : 1.6) * 0.30 +
    norm(wavg('wardsKilled'),   0, isSupport ? 1.5 : 0.9) * 0.20
  ) * visionBoost * 0.80 + turretConv * 0.20;

  // AXE 3 - IMPACT COLLECTIF (17%)
  const kpWin  = winM.length  ? winM.reduce((s, m)  => s + m.player.killParticipation, 0) / winM.length  : 0;
  const kpLoss = lossM.length ? lossM.reduce((s, m) => s + m.player.killParticipation, 0) / lossM.length : 0;
  const avgObj = wavg('turretTakedowns') + wavg('dragonTakedowns') * 1.5 + wavg('baronTakedowns') * 2.0;
  const scoreC = (norm(kpLoss, 0.35, 0.75) * 0.60 + norm(kpWin, 0.45, 0.85) * 0.40) * 0.35
    + norm(wavg('teamDmgPct'), bench.teamDmgPct * 0.5, bench.teamDmgPct * 1.8) * 0.30
    + norm(avgObj, 0, isSupport ? 2.0 : 3.5) * 0.25
    + (isSupport ? norm(wavg('saveAllyFromDeath'), 0, 1.5) : norm(wavg('saveAllyFromDeath'), 0, 0.5)) * 0.10;

  // AXE 4 - EFFICACITE ECONOMIQUE (15%)
  const goldRef = isSupport ? 280 : isJungle ? 380 : 420;
  const scoreD  = norm(wavgLoss('goldPerMin'), goldRef * 0.6, goldRef * 1.5) * 0.40
    + (isSupport ? 0.5 : norm(wavg('csPerMin'), bench.csPerMin * 0.5, bench.csPerMin * 1.4)) * 0.35
    + (isSupport || isJungle ? 0.5 : norm(wavg('maxCsAdvantage'), 0, 40)) * 0.25;

  // AXE 5 - PERFORMANCE LOBBY (25%)
  let lobbyPerfSum = 0, lobbyWeightSum = 0, totalLobbyMMR = 0, lobbyCount = 0;
  for (const m of matches) {
    const lobbyMMRs = m.allPuuids
      .filter(p => p !== m.player.puuid && cache[p])
      .map(p => {
        const e = (cache[p] || []).find(x => x.queueType === 'RANKED_SOLO_5x5')
               || (cache[p] || []).find(x => x.queueType === 'RANKED_FLEX_SR');
        return e ? tierToMMR(e.tier, e.rank, e.leaguePoints) : 0;
      }).filter(x => x > 0);
    if (!lobbyMMRs.length) continue;
    const avgLobby = lobbyMMRs.reduce((a, b) => a + b, 0) / lobbyMMRs.length;
    const delta    = (m.player.win ? 1 : 0) - expectedWR(playerMMR, avgLobby);
    const mult     = Math.max(0.5, Math.min(2.0, 1.0 + ((avgLobby - playerMMR) / 400) * 0.3));
    lobbyPerfSum   += delta * mult * m.weight;
    lobbyWeightSum += m.weight;
    totalLobbyMMR  += avgLobby;
    lobbyCount++;
  }
  const avgLobbyPerf = lobbyWeightSum > 0 ? lobbyPerfSum / lobbyWeightSum : 0;
  const scoreE       = norm(avgLobbyPerf + 0.5, 0, 1.0);
  const avgLobbyMMR  = lobbyCount > 0 ? Math.round(totalLobbyMMR / lobbyCount) : playerMMR;

  // AXE 6 - CONSISTANCE (10%)
  const scoreF = consistencyRatio(matches, 'damagePerMin')     * 0.40
               + consistencyRatio(matches, 'killParticipation') * 0.35
               + consistencyRatio(matches, 'visionPerMin')      * 0.25;

  // SCORE FINAL
  let final = Math.pow(
    scoreA * 0.18 + scoreB * 0.15 + scoreC * 0.17 + scoreD * 0.15 + scoreE * 0.25 + scoreF * 0.10,
    0.80
  ) * 20;

  const tierIdx = Object.keys(TIER_MMR).indexOf(rankInfo.tier);
  if (tierIdx >= 6) final = Math.max(final, 13.0);
  if (tierIdx === 0) final = Math.min(final, 8.5);

  const bonusList = [];
  const dmgCons   = consistencyRatio(matches, 'damagePerMin');
  if (dmgCons > 0.80) { final += 0.4; bonusList.push('+0.4 Performance stable meme en losing'); }
  if (avgLobbyPerf > 0.10) { final += 0.5; bonusList.push('+0.5 Surperforme son niveau de lobby'); }
  const soloGames = matches.filter(m => m.queueId === 420).length;
  if (soloGames < 10) { final -= 0.4; bonusList.push(`-0.4 Peu de parties SoloQ (${soloGames})`); }

  final = Math.round(Math.max(1.0, Math.min(20.0, final)) * 10) / 10;

  const wr = Math.round(matches.filter(m => m.player.win).length / matches.length * 100);

  // Top champions
  const champData = {};
  for (const m of matches) {
    const c = m.player.champion;
    if (!champData[c]) champData[c] = { wins: 0, games: 0 };
    champData[c].games++;
    if (m.player.win) champData[c].wins++;
  }
  const topChampions = Object.keys(champData)
    .sort((a, b) => champData[b].games - champData[a].games)
    .slice(0, 3)
    .map(n => ({ name: n, games: champData[n].games, wr: Math.round(champData[n].wins / champData[n].games * 100) }));

  // WR par role
  const roleData = {};
  for (const m of matches) {
    const r = m.player.role;
    if (!roleData[r]) roleData[r] = { wins: 0, games: 0 };
    roleData[r].games++;
    if (m.player.win) roleData[r].wins++;
  }
  const wrByRole = {};
  for (const r in roleData) wrByRole[r] = { wr: Math.round(roleData[r].wins / roleData[r].games * 100), games: roleData[r].games };

  const smurfFlag  = scoreE < 0.35 && ((scoreA * 0.18 + scoreD * 0.15) / 0.33) > 0.65;
  const boostedFlag = scoreE > 0.65 && ((scoreA * 0.18 + scoreD * 0.15) / 0.33) < 0.30;

  return {
    score: final,
    breakdown: {
      mecanique:   Math.round(scoreA * 20 * 10) / 10,
      vision:      Math.round(scoreB * 20 * 10) / 10,
      impact:      Math.round(scoreC * 20 * 10) / 10,
      efficacite:  Math.round(scoreD * 20 * 10) / 10,
      lobby:       Math.round(scoreE * 20 * 10) / 10,
      consistance: Math.round(scoreF * 20 * 10) / 10,
    },
    stats: {
      games: matches.length, soloGames, wr,
      kda:          Math.round(wavg('kda') * 100) / 100,
      dmgPerMin:    Math.round(wavg('damagePerMin')),
      csPerMin:     Math.round(wavg('csPerMin') * 10) / 10,
      visionPerMin: Math.round(wavg('visionPerMin') * 100) / 100,
      kp:           Math.round(wavg('killParticipation') * 100),
      mainRole, topChampions, wrByRole, avgLobbyMMR, playerMMR,
    },
    bonusList, smurfFlag, boostedFlag, rankInfo,
  };
}

// ============================================================
// FORMAT EMBED DISCORD
// ============================================================

function bar(val) {
  const f = Math.round(Math.max(0, Math.min(20, val)) / 2);
  return 'X'.repeat(f) + '-'.repeat(10 - f);
}

function mmrToLabel(mmr) {
  if (mmr >= 3200) return 'Grandmaster+';
  if (mmr >= 3000) return 'Master';
  if (mmr >= 2600) return 'Diamond';
  if (mmr >= 2200) return 'Emerald';
  if (mmr >= 1800) return 'Platinum';
  if (mmr >= 1400) return 'Gold';
  if (mmr >= 1000) return 'Silver';
  if (mmr >= 600)  return 'Bronze';
  return 'Iron';
}

function buildEmbed(result, playerName) {
  const s  = result.score;
  const b  = result.breakdown;
  const st = result.stats;
  const ri = result.rankInfo;
  const color = s >= 17 ? 0xFFD700 : s >= 14 ? 0x9B59B6 : s >= 11 ? 0x1ABC9C : s >= 8 ? 0x3498DB : 0x95A5A6;
  const rankStr = ri.tier ? `${ri.tier.charAt(0) + ri.tier.slice(1).toLowerCase()} ${ri.rank} - ${ri.lp} LP` : 'Non classe';
  const champsStr = st.topChampions.map(c => `${c.name} (${c.wr}% - ${c.games}g)`).join(' | ') || 'N/A';
  const roleWRStr = Object.entries(st.wrByRole)
    .filter(([, d]) => d.games >= 3).sort((a, b) => b[1].games - a[1].games)
    .map(([r, d]) => `${ROLE_LABEL[r] || r} ${d.wr}% (${d.games}g)`).join('  |  ') || 'N/A';

  return {
    title: `CZF Score - ${playerName}`,
    color,
    fields: [
      { name: 'Score Global', value: `**${s} / 20**`, inline: false },
      {
        name:  'Detail par axe',
        value: `\`Mecanique    [${bar(b.mecanique)}] ${b.mecanique}\`\n`
             + `\`Vision/Macro [${bar(b.vision)}] ${b.vision}\`\n`
             + `\`Impact       [${bar(b.impact)}] ${b.impact}\`\n`
             + `\`Efficacite   [${bar(b.efficacite)}] ${b.efficacite}\`\n`
             + `\`Lobby relat. [${bar(b.lobby)}] ${b.lobby}\`\n`
             + `\`Consistance  [${bar(b.consistance)}] ${b.consistance}\``,
        inline: false
      },
      {
        name:  'Stats',
        value: `**Rang** : ${rankStr}\n**Role** : ${ROLE_LABEL[st.mainRole] || st.mainRole}\n`
             + `**WR** : ${st.wr}% sur ${st.games} parties\n**KDA** : ${st.kda}\n`
             + `**Dmg/min** : ${st.dmgPerMin}  **CS/min** : ${st.csPerMin}  **KP** : ${st.kp}%`,
        inline: false
      },
      {
        name:  'Analyse Lobby',
        value: `**Niveau moyen de tes lobbies** : ~${mmrToLabel(st.avgLobbyMMR)}\n**Ton niveau** : ~${mmrToLabel(st.playerMMR)}`,
        inline: false
      },
      { name: 'Top champions', value: champsStr, inline: false },
      { name: 'WR par role',   value: roleWRStr, inline: false },
      ...(result.bonusList.length ? [{ name: 'Ajustements', value: result.bonusList.join('\n'), inline: false }] : []),
      ...(result.smurfFlag   ? [{ name: 'Analyse', value: 'Profil potentiellement sous-classe', inline: false }] : []),
      ...(result.boostedFlag ? [{ name: 'Analyse', value: 'Profil potentiellement booste',      inline: false }] : []),
    ],
    footer:    { text: `CZF Bot v4 - ${st.games} parties analysees` },
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// CLOUDFLARE KV
// ============================================================

async function saveKV(key, value) {
  if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE || !CF_KV_TOKEN) return;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/${encodeURIComponent(key)}`,
    { method: 'PUT', headers: { 'Authorization': `Bearer ${CF_KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
  );
}

async function getKV(key) {
  if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE || !CF_KV_TOKEN) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/${encodeURIComponent(key)}`,
    { headers: { 'Authorization': `Bearer ${CF_KV_TOKEN}` } }
  );
  if (res.status !== 200) return null;
  return res.json();
}

// ============================================================
// ANALYSE PRINCIPALE
// ============================================================

async function runAnalysis(gameName, tagLine, interactionToken, jobId) {
  const playerKey  = `${gameName}#${tagLine}`.toLowerCase();
  const playerName = `${gameName}#${tagLine}`;
  console.log(`=== Analyse: ${playerKey} ===`);

  // Retourner le cache si deja analyse (sauf compte test)
  if (playerKey !== TEST_ACCOUNT && analysisCache.has(playerKey)) {
    console.log(`Cache hit: ${playerKey} - renvoi du resultat existant`);
    const cached = analysisCache.get(playerKey);
    if (interactionToken) {
      await fetch(
        `https://discord.com/api/webhooks/${DISCORD_APP_ID}/${interactionToken}/messages/@original`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` },
          body:    JSON.stringify({
            content: `Score deja calcule pour **${playerName}** — analyse unique par compte.`,
            embeds:  [cached.embed]
          })
        }
      ).catch(() => {});
    }
    return cached;
  }

  try {
    const account = await getAccount(gameName, tagLine);
    if (!account) throw new Error(`Compte introuvable: ${playerName}`);
    console.log(`PUUID: ${account.puuid.substring(0, 20)}...`);

    const { matches, cache } = await collectAll(account.puuid);
    if (!matches || matches.length < 5) throw new Error(`Pas assez de parties (${matches?.length || 0})`);

    const rankedData = cache[account.puuid] || [];
    const rankInfo   = extractRankInfo(rankedData);
    console.log(`Rang: ${rankInfo.tier || 'Non classe'} (${rankInfo.mmr} MMR)`);

    const result = calculate(rankInfo, matches, cache);
    if (result.error) throw new Error(result.error);
    console.log(`Score: ${result.score} / 20`);

    const embed  = buildEmbed(result, playerName);

    // 1. Poster via webhook Discord (ne depend pas du token, toujours disponible)
    if (DISCORD_WEBHOOK_SCORES) {
      await fetch(DISCORD_WEBHOOK_SCORES, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          content: `Score calcule pour **${playerName}**`,
          embeds:  [embed]
        })
      }).then(r => console.log(`Webhook Discord: ${r.status}`))
        .catch(e => console.log(`Webhook erreur: ${e.message}`));
    }

    // 2. Tenter aussi de mettre a jour le message original (peut avoir expire apres 15min)
    if (interactionToken) {
      const dr = await fetch(
        `https://discord.com/api/webhooks/${DISCORD_APP_ID}/${interactionToken}/messages/@original`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` },
          body:    JSON.stringify({ embeds: [embed] })
        }
      ).catch(() => null);
      if (dr) console.log(`Discord interaction update: ${dr.status}`);
    }

    const kvData = { playerName, result, embed, updatedAt: new Date().toISOString() };

    // Sauvegarder dans le cache memoire
    analysisCache.set(playerKey, kvData);
    console.log(`Cache sauvegarde pour ${playerKey} (${analysisCache.size} comptes en cache)`);

    await saveKV(`score:${playerKey}`, kvData);
    if (jobId) await saveKV(`job:${jobId}`, { status: 'done', ...kvData });

    console.log(`=== Termine: ${playerName} ===`);
    return kvData;

  } catch (err) {
    console.error(`ERREUR: ${err.message}`);
    if (interactionToken) {
      await fetch(
        `https://discord.com/api/webhooks/${DISCORD_APP_ID}/${interactionToken}/messages/@original`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` },
          body:    JSON.stringify({ content: `Erreur pour **${playerName}** : ${err.message}` })
        }
      ).catch(() => {});
    }
    if (jobId) await saveKV(`job:${jobId}`, { status: 'error', error: err.message });
    throw err;
  }
}

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => res.json({ status: 'CZF Score Bot OK', version: '4.0' }));

app.post('/analyze', async (req, res) => {
  if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { gameName, tagLine, interactionToken } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: 'gameName et tagLine requis' });
  const jobId = `${gameName}_${tagLine}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  res.json({ jobId, status: 'started' });
  runAnalysis(gameName, tagLine, interactionToken, jobId).catch(console.error);
});

app.post('/web/analyze', async (req, res) => {
  const { pseudo } = req.body;
  if (!pseudo || !pseudo.includes('#')) return res.status(400).json({ error: 'Format invalide. Utilise Nom#TAG' });
  const [gameName, tagLine] = pseudo.split('#');
  const jobId = `${gameName}_${tagLine}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  await saveKV(`job:${jobId}`, { status: 'pending', playerName: pseudo });
  res.json({ jobId });
  runAnalysis(gameName, tagLine, null, jobId).catch(console.error);
});

app.get('/web/result/:jobId', async (req, res) => {
  const data = await getKV(`job:${req.params.jobId}`);
  if (!data) return res.status(404).json({ status: 'not_found' });
  res.json(data);
});

app.get('/web/score/:pseudo', async (req, res) => {
  const data = await getKV(`score:${decodeURIComponent(req.params.pseudo).toLowerCase()}`);
  if (!data) return res.status(404).json({ error: 'Aucun score trouve' });
  res.json(data);
});

// ============================================================
// DEMARRAGE
// ============================================================

app.listen(PORT, () => {
  console.log(`CZF Score Bot v4 demarre sur le port ${PORT}`);
  console.log(`Season start: ${new Date(SEASON_START * 1000).toISOString().substring(0, 10)}`);
  if (!RIOT_API_KEY)           console.warn('⚠️  RIOT_API_KEY manquante');
  if (!DISCORD_BOT_TOKEN)      console.warn('⚠️  DISCORD_BOT_TOKEN manquante');
  if (!DISCORD_WEBHOOK_SCORES) console.warn('⚠️  DISCORD_WEBHOOK_SCORES manquante (webhook desactive)');
  if (!CF_KV_TOKEN)            console.warn('⚠️  CF_KV_TOKEN manquante (KV desactive)');
});
