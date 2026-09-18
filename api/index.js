const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

if (!admin.apps.length) {
  let serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (typeof serviceAccount === 'string') {
    try {
      serviceAccount = JSON.parse(serviceAccount);
    } catch (e) {
      console.error('Firebase JSON parse error:', e);
    }
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// Track Click Event
app.post('/api/track-click', async (req, res) => {
  try {
    const { fbclid, event_id } = req.body;
    await db.collection('clicks').add({
      fbclid: fbclid || null,
      event_id: event_id || null,
      created_at: new Date().toISOString()
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Send CAPI to Meta
async function sendMetaCAPI(fbclid, eventId) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!pixelId || !token) return false;

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          event_id: eventId || undefined,
          user_data: { client_ip_address: '127.0.0.1', client_user_agent: 'TelegramBot' }
        }]
      })
    });
    const resData = await response.json();
    return resData.events_received > 0;
  } catch (e) {
    return false;
  }
}

// Telegram Webhook Event
app.post('/api/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (update.chat_member) {
      const cm = update.chat_member;
      const newStatus = cm.new_chat_member?.status;
      const oldStatus = cm.old_chat_member?.status;

      if (['member', 'administrator', 'creator'].includes(newStatus) && ['left', 'kicked'].includes(oldStatus)) {
        const user = cm.new_chat_member.user;
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
        const username = user.username ? `@${user.username}` : '—';

        const clicksSnap = await db.collection('clicks').orderBy('created_at', 'desc').limit(1).get();
        let source = 'organic';
        let sentToMeta = false;

        if (!clicksSnap.empty) {
          const lastClick = clicksSnap.docs[0].data();
          if (lastClick.fbclid) {
            source = 'meta_ads';
            sentToMeta = await sendMetaCAPI(lastClick.fbclid, lastClick.event_id);
          }
        }

        await db.collection('joins').add({
          user_id: user.id,
          name: name,
          username: username,
          joined_at: new Date().toISOString(),
          source: source,
          sent_to_meta: sentToMeta
        });
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    return res.status(200).send('OK');
  }
});

// Dashboard Stats Endpoint
app.get('/api/stats', async (req, res) => {
  const { password } = req.query;
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const clicksSnap = await db.collection('clicks').get();
    const joinsSnap = await db.collection('joins').get();

    const totalClicks = clicksSnap.size;
    const totalJoins = joinsSnap.size;
    let sentToMeta = 0;
    const recentJoins = [];

    joinsSnap.forEach(doc => {
      const d = doc.data();
      if (d.sent_to_meta) sentToMeta++;
      recentJoins.push(d);
    });

    recentJoins.sort((a, b) => new Date(b.joined_at) - new Date(a.joined_at));

    const fakeClicks = Math.max(0, totalClicks - totalJoins);
    const conversionRate = totalClicks > 0 ? ((totalJoins / totalClicks) * 100).toFixed(1) : 0;

    return res.status(200).json({
      totalClicks,
      totalJoins,
      fakeClicks,
      conversionRate,
      sentToMeta,
      recentJoins: recentJoins.slice(0, 50)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = app;