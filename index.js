const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const admin   = require('firebase-admin');
const app     = express();

app.use(cors({ origin: 'https://callmehd.neocities.org' }));
app.use(express.json());

// ── FIREBASE ADMIN ──
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  })
});
const db = admin.firestore();

// ── AUTH MIDDLEWARE ──
function requireSecret(req, res, next) {
  if (req.headers['x-neo-secret'] !== process.env.NEO_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── DISCORD OAUTH EXCHANGE ──
app.post('/discord/exchange', async (req, res) => {
  const { code, uid } = req.body;
  if (!code || !uid) return res.status(400).json({ error: 'Missing code or uid' });
  try {
    const params = new URLSearchParams({
      client_id:     process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  process.env.DISCORD_REDIRECT_URI
    });
    const tokenRes  = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).json({ error: 'OAuth failed', detail: tokenData });

    // get discord user
    const userRes  = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const discordUser = await userRes.json();
    if (!discordUser.id) return res.status(400).json({ error: 'Could not fetch discord user' });

    // check not already linked to another account
    const existing = await db.collection('users')
      .where('discord_id', '==', discordUser.id).get();
    if (!existing.empty && existing.docs[0].id !== uid)
      return res.status(409).json({ error: 'discord_already_linked' });

    // update firebase user
    await db.collection('users').doc(uid).update({
      discord_id:    discordUser.id,
      discord_tag:   discordUser.username,
      avatar_url:    discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : '',
      discord_linked_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, discord_id: discordUser.id, username: discordUser.username });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DISCORD DM VERIFICATION ──
app.post('/discord/send-verify', requireSecret, async (req, res) => {
  const { discord_id, code, site_url } = req.body;
  try {
    // open DM channel
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN
      },
      body: JSON.stringify({ recipient_id: discord_id })
    });
    const dm = await dmRes.json();

    // send verification message
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN
      },
      body: JSON.stringify({
        content: `**nullscapes Game Corner** — Account Verification\n\nClick to verify: ${site_url}?verify=${code}\n\nOr enter this code on the site: \`${code}\`\n\n*This code expires in 10 minutes.*`
      })
    });

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BOT SYNC (from neoEngine) ──
app.post('/neo-sync', requireSecret, async (req, res) => {
  const { event, uid, ...data } = req.body;
  try {
    switch(event) {
      case 'achievement':
        // notify bot of achievement
        break;
      case 'purchase':
        await db.collection('users').doc(uid).update({
          [`purchases.${data.item}`]: true
        });
        break;
      case 'ban':
        await db.collection('users').doc(uid).update({ is_banned: true, ban_reason: data.reason });
        break;
      case 'vip_grant':
        await db.collection('users').doc(uid).update({ vip_tier: data.tier });
        break;
      case 'daily_claim':
        // log it
        break;
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BOT → SITE (from neoGenesis bot) ──
app.post('/bot-update', requireSecret, async (req, res) => {
  const { uid, updates } = req.body;
  if (!uid || !updates) return res.status(400).json({ error: 'Missing uid or updates' });
  try {
    // whitelist what the bot can update
    const allowed = ['luck', 'garnet', 'glimmose', 'discord_id', 'birthday', 'best_friends'];
    const safe = {};
    for (const k of allowed) { if (updates[k] !== undefined) safe[k] = updates[k]; }
    await db.collection('users').doc(uid).update(safe);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'neo-sync online' }));

app.listen(process.env.PORT || 3000, () => console.log('neo-sync running'));
