// =============================================================
// server.js - Serveur CZF Score Bot
// =============================================================

const express = require('express');
const fetch   = require('node-fetch');
const { getAccountByRiotId, getRankedByPuuid } = require('./riot');
const { collectAllData, calculate, extractRankInfo } = require('./score');

const app  = express();
const PORT = process.env.PORT || 3000;

// Variables d'environnement (definies sur Render.com)
const RIOT_API_KEY      = process.env.RIOT_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID    = process.env.DISCORD_APP_ID;
const SECRET_KEY        = process.env.SECRET_KEY || 'czf-secret-2025';
const CF_ACCOUNT_ID     = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE   = process.env.CF_KV_NAMESPACE;
const CF_KV_TOKEN       = process.env.CF_KV_TOKEN;

const SEASON_START = 1736294400;
const MAX_GAMES    = 20; // Augmenter a 50-100 apres validation

app.use(express.json());

// CORS pour Cloudflare Pages
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Secret-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// HELPERS DISCORD
// ============================================================

async function updateDiscordMessage(token, payload) {
  const res = await fetch(
    `https://discord.com/api/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`,
    {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`
      },
      body: JSON.stringify(payload)
    }
  );
  return res.status;
}

// ============================================================
// HELPERS CLOUDFLARE KV
// Stocke les resultats pour la page web
// ============================================================

async function saveToKV(key, value) {
  if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE || !CF_KV_TOKEN) return;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/${encodeURIComponent(key)}`,
    {
      method:  'PUT',
      headers: {
        'Authorization': `Bearer ${CF_KV_TOKEN}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(value)
    }
  );
}

async function getFromKV(key) {
  if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE || !CF_KV_TOKEN) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/${encodeURIComponent(key)}`,
    {
      headers: { 'Authorization': `Bearer ${CF_KV_TOKEN}` }
    }
  );
  if (res.status !== 200) return null;
  return res.json();
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

const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

function buildEmbed(result, playerName) {
  const s  = result.score;
  const b  = result.breakdown;
  const st = result.stats;
  const ri = result.rankInfo;

  const color = s >= 17 ? 0xFFD700 : s >= 14 ? 0x9B59B6 : s >= 11 ? 0x1ABC9C : s >= 8 ? 0x3498DB : 0x95A5A6;
  const rankStr = ri.tier
    ? `${ri.tier.charAt(0) + ri.tier.slice(1).toLowerCase()} ${ri.rank} - ${ri.lp} LP`
    : 'Non classe';

  const champsStr = st.topChampions.map(c => `${c.name} (${c.wr}% - ${c.games}g)`).join(' | ') || 'N/A';
  const roleWRStr = Object.entries(st.wrByRole)
    .filter(([, d]) => d.games >= 3)
    .sort((a, b) => b[1].games - a[1].games)
    .map(([r, d]) => `${ROLE_LABEL[r] || r} ${d.wr}% (${d.games}g)`)
    .join('  |  ') || 'N/A';

  return {
    title: `CZF Score - ${playerName}`,
    color,
    fields: [
      { name: 'Score Global', value: `**${s} / 20**`, inline: false },
      {
        name: 'Detail par axe',
        value: `\`Mecanique    [${bar(b.mecanique)}] ${b.mecanique}\`\n`
             + `\`Vision/Macro [${bar(b.vision)}] ${b.vision}\`\n`
             + `\`Impact       [${bar(b.impact)}] ${b.impact}\`\n`
             + `\`Efficacite   [${bar(b.efficacite)}] ${b.efficacite}\`\n`
             + `\`Lobby relat. [${bar(b.lobby)}] ${b.lobby}\`\n`
             + `\`Consistance  [${bar(b.consistance)}] ${b.consistance}\``,
        inline: false
      },
      {
        name: 'Stats',
        value: `**Rang** : ${rankStr}\n**Role** : ${ROLE_LABEL[st.mainRole] || st.mainRole}\n`
             + `**WR** : ${st.wr}% sur ${st.games} parties\n**KDA** : ${st.kda}\n`
             + `**Dmg/min** : ${st.dmgPerMin}\n**CS/min** : ${st.csPerMin}\n**KP** : ${st.kp}%`,
        inline: false
      },
      {
        name: 'Analyse Lobby',
        value: `**Niveau moyen de tes lobbies** : ~${mmrToLabel(st.avgLobbyMMR)}\n`
             + `**Ton niveau** : ~${mmrToLabel(st.playerMMR)}`,
        inline: false
      },
      { name: 'Top champions', value: champsStr, inline: false },
      { name: 'WR par role',   value: roleWRStr, inline: false },
      ...(result.bonusList.length ? [{ name: 'Ajustements', value: result.bonusList.join('\n'), inline: false }] : []),
      ...(result.smurfFlag   ? [{ name: 'Analyse', value: 'Profil potentiellement sous-classe', inline: false }] : []),
      ...(result.boostedFlag ? [{ name: 'Analyse', value: 'Profil potentiellement booste', inline: false }] : []),
    ],
    footer: { text: `CZF Bot v4 - ${st.games} parties analysees` },
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// FONCTION PRINCIPALE D'ANALYSE
// ============================================================

async function runAnalysis(gameName, tagLine, interactionToken, jobId) {
  console.log(`=== Analyse: ${gameName}#${tagLine} ===`);

  try {
    // 1. PUUID
    const account = await getAccountByRiotId(gameName, tagLine, RIOT_API_KEY);
    if (!account) throw new Error(`Compte introuvable : ${gameName}#${tagLine}`);

    // 2. Rang
    const rankCache  = {};
    const rankedData = await getRankedByPuuid(account.puuid, RIOT_API_KEY, rankCache);
    const rankInfo   = extractRankInfo(rankedData);
    console.log(`Rang: ${rankInfo.tier || 'Non classe'} (${rankInfo.mmr} MMR)`);

    // 3. Parties + lobbies
    const { matches, rankCache: fullCache } = await collectAllData(
      account.puuid, RIOT_API_KEY, MAX_GAMES, SEASON_START
    );

    if (!matches || matches.length < 5) {
      throw new Error(`Pas assez de parties cette saison (${matches?.length || 0})`);
    }

    // 4. Score
    const result = calculate(rankInfo, matches, fullCache);
    console.log(`Score: ${result.score} / 20`);

    if (result.error) throw new Error(result.error);

    const playerName = `${gameName}#${tagLine}`;
    const embed = buildEmbed(result, playerName);

    // 5. Mettre a jour Discord (si vient d'une slash command)
    if (interactionToken) {
      const status = await updateDiscordMessage(interactionToken, { embeds: [embed] });
      console.log(`Discord update: ${status}`);
    }

    // 6. Sauvegarder dans KV pour la page web
    const kvData = {
      playerName,
      result,
      embed,
      updatedAt: new Date().toISOString()
    };
    await saveToKV(`score:${playerName.toLowerCase()}`, kvData);
    if (jobId) await saveToKV(`job:${jobId}`, { status: 'done', ...kvData });

    console.log(`=== Analyse terminee: ${playerName} ===`);
    return kvData;

  } catch (err) {
    console.error(`ERREUR: ${err.message}`);
    if (interactionToken) {
      await updateDiscordMessage(interactionToken, {
        content: `Erreur pour **${gameName}#${tagLine}** : ${err.message}`
      });
    }
    if (jobId) {
      await saveToKV(`job:${jobId}`, { status: 'error', error: err.message });
    }
    throw err;
  }
}

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'CZF Score Bot OK', version: '4.0' });
});

// Declenche une analyse (appele par le Cloudflare Worker depuis Discord)
// Authentifie par SECRET_KEY
app.post('/analyze', async (req, res) => {
  if (req.headers['x-secret-key'] !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { gameName, tagLine, interactionToken } = req.body;
  if (!gameName || !tagLine) {
    return res.status(400).json({ error: 'gameName et tagLine requis' });
  }

  // Repondre immediatement (l'analyse tourne en arriere-plan)
  const jobId = `${gameName}_${tagLine}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  res.json({ jobId, status: 'started' });

  // Lancer l'analyse en arriere-plan
  runAnalysis(gameName, tagLine, interactionToken, jobId).catch(console.error);
});

// Appele par la page web (Cloudflare Pages) pour lancer une analyse
app.post('/web/analyze', async (req, res) => {
  const { pseudo } = req.body;
  if (!pseudo || !pseudo.includes('#')) {
    return res.status(400).json({ error: 'Format invalide. Utilise Nom#TAG' });
  }

  const [gameName, tagLine] = pseudo.split('#');
  const jobId = `${gameName}_${tagLine}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');

  // Sauvegarder le job comme "en cours" dans KV
  await saveToKV(`job:${jobId}`, { status: 'pending', playerName: pseudo });

  // Repondre avec le jobId pour que la page puisse poller
  res.json({ jobId });

  // Lancer en arriere-plan
  runAnalysis(gameName, tagLine, null, jobId).catch(console.error);
});

// Verifie le statut d'un job (polle par la page web)
app.get('/web/result/:jobId', async (req, res) => {
  const data = await getFromKV(`job:${req.params.jobId}`);
  if (!data) return res.status(404).json({ status: 'not_found' });
  res.json(data);
});

// Recupere le dernier score d'un joueur
app.get('/web/score/:pseudo', async (req, res) => {
  const key  = `score:${decodeURIComponent(req.params.pseudo).toLowerCase()}`;
  const data = await getFromKV(key);
  if (!data) return res.status(404).json({ error: 'Aucun score trouve pour ce joueur' });
  res.json(data);
});

// ============================================================
// DEMARRAGE
// ============================================================

app.listen(PORT, () => {
  console.log(`CZF Score Bot demarre sur le port ${PORT}`);
  if (!RIOT_API_KEY)      console.warn('⚠️  RIOT_API_KEY manquante');
  if (!DISCORD_BOT_TOKEN) console.warn('⚠️  DISCORD_BOT_TOKEN manquante');
  if (!CF_KV_TOKEN)       console.warn('⚠️  CF_KV_TOKEN manquante (KV desactive)');
});
