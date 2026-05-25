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

    const userRes     = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const discordUser = await userRes.json();
    if (!discordUser.id) return res.status(400).json({ error: 'Could not fetch discord user' });

    // check not already linked to another account
    const existing = await db.collection('users').where('discord_id', '==', discordUser.id).get();
    if (!existing.empty && existing.docs[0].id !== uid)
      return res.status(409).json({ error: 'discord_already_linked' });

    // pull bot profile data if it exists
    const botUser = await db.collection('bot_users').doc(discordUser.id).get();
    const botData = botUser.exists ? botUser.data() : {};

    // update firebase user with discord + bot profile data
    await db.collection('users').doc(uid).update({
      discord_id:    discordUser.id,
      discord_tag:   discordUser.username,
      avatar_url:    discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : (botData.avatar_url || ''),
      // import bot profile colors if they exist
      ...(botData.profile_color    ? { profile_color_primary:   botData.profile_color }    : {}),
      ...(botData.profile_subcolor ? { profile_color_secondary: botData.profile_subcolor } : {}),
      discord_linked_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success:    true,
      discord_id: discordUser.id,
      username:   discordUser.username,
      imported_bot_colors: !!botData.profile_color
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BOT REGISTER (called by BotGhost on user registration) ──
app.post('/bot-register', requireSecret, async (req, res) => {
  const { discord_id, username, avatar_url, profile_color, profile_subcolor } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'Missing discord_id' });
  try {
    await db.collection('bot_users').doc(discord_id).set({
      discord_id,
      username:         username         || '',
      avatar_url:       avatar_url       || '',
      profile_color:    profile_color    || '',
      profile_subcolor: profile_subcolor || '',
      synced_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // if already linked to a site account, sync colors there too
    const linked = await db.collection('users').where('discord_id', '==', discord_id).get();
    if (!linked.empty) {
      await linked.docs[0].ref.update({
        ...(profile_color    ? { profile_color_primary:   profile_color }    : {}),
        ...(profile_subcolor ? { profile_color_secondary: profile_subcolor } : {})
      });
    }

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BOT → SITE UPDATES ──
app.post('/bot-update', requireSecret, async (req, res) => {
  const { uid, updates } = req.body;
  if (!uid || !updates) return res.status(400).json({ error: 'Missing uid or updates' });
  try {
    const allowed = ['luck', 'garnet', 'glimmose', 'discord_id', 'birthday', 'best_friends'];
    const safe = {};
    for (const k of allowed) { if (updates[k] !== undefined) safe[k] = updates[k]; }
    await db.collection('users').doc(uid).update(safe);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── NEO-SYNC (from neoEngine) ──
app.post('/neo-sync', requireSecret, async (req, res) => {
  const { event, uid, ...data } = req.body;
  try {
    switch(event) {
      case 'purchase':
        await db.collection('users').doc(uid).update({ [`purchases.${data.item}`]: true });
        break;
      case 'ban':
        await db.collection('users').doc(uid).update({ is_banned: true, ban_reason: data.reason });
        break;
      case 'vip_grant':
        await db.collection('users').doc(uid).update({ vip_tier: data.tier });
        break;
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'neo-sync online' }));

app.listen(process.env.PORT || 3000, () => console.log('neo-sync running'));
