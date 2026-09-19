const express = require('express');
const admin = require('firebase-admin');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- FIREBASE INITIALIZATION ----------------
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (e) {
    console.error('Firebase Initialization Error:', e.message);
  }
}

const db = admin.firestore();
const statsRef = db.collection('analytics').doc('tracker_stats');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456';

// Meta Conversions API (CAPI) Helper - Transmits Lead & Subscribe Events
async function sendMetaCapiEvent(userId) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              event_name: 'Lead',
              event_time: Math.floor(Date.now() / 1000),
              action_source: 'system_generated',
              user_data: { external_id: [String(userId)] }
            },
            {
              event_name: 'Subscribe',
              event_time: Math.floor(Date.now() / 1000),
              action_source: 'system_generated',
              user_data: { external_id: [String(userId)] }
            }
          ]
        })
      }
    );

    if (response.ok) {
      await statsRef.set({
        sentToMeta: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
    } else {
      const errData = await response.json();
      console.error('Meta CAPI Error:', errData);
    }
  } catch (err) {
    console.error('Meta CAPI Error:', err.message);
  }
}

// 1. Track Landing Page Click (Saves to Firebase instantly)
app.all('/api/track-click', async (req, res) => {
  try {
    await statsRef.set({
      totalClicks: admin.firestore.FieldValue.increment(1),
      fakeClicks: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    return res.json({ success: true });
  } catch (err) {
    console.error('Click Track Error:', err);
    return res.status(500).json({ error: 'Database update failed' });
  }
});

// 2. Telegram Webhook Handler
app.post('/api', async (req, res) => {
  try {
    const update = req.body;
    let userToTrack = null;

    if (update.chat_join_request) {
      const joinReq = update.chat_join_request;
      userToTrack = {
        userId: joinReq.from.id,
        name: `${joinReq.from.first_name || ''} ${joinReq.from.last_name || ''}`.trim() || 'Telegram User',
        username: joinReq.from.username ? `@${joinReq.from.username}` : '—'
      };
    } else if (update.chat_member) {
      const member = update.chat_member;
      if (['member', 'administrator', 'creator'].includes(member.new_chat_member?.status)) {
        const user = member.new_chat_member.user;
        userToTrack = {
          userId: user.id,
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User',
          username: user.username ? `@${user.username}` : '—'
        };
      }
    }

    if (userToTrack) {
      const doc = await statsRef.get();
      const currentData = doc.exists ? doc.data() : {};
      const recentJoins = currentData.recentJoins || [];

      const exists = recentJoins.some(j => j.userId === userToTrack.userId);
      if (!exists) {
        userToTrack.joined_at = new Date().toISOString();
        recentJoins.unshift(userToTrack);
        if (recentJoins.length > 50) recentJoins.pop();

        await statsRef.set({
          totalJoins: admin.firestore.FieldValue.increment(1),
          recentJoins: recentJoins
        }, { merge: true });

        await sendMetaCapiEvent(userToTrack.userId);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).send('OK');
  }
});

// 3. Dashboard Data Stats Endpoint (Reads from Firebase)
app.get('/api/stats', async (req, res) => {
  if (req.query.password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const doc = await statsRef.get();
    const data = doc.exists ? doc.data() : {
      totalClicks: 0,
      totalJoins: 0,
      fakeClicks: 0,
      sentToMeta: 0,
      recentJoins: []
    };

    const totalClicks = data.totalClicks || 0;
    const totalJoins = data.totalJoins || 0;
    const conversionRate = totalClicks > 0
      ? ((totalJoins / totalClicks) * 100).toFixed(1)
      : '0';

    res.json({
      totalClicks: totalClicks,
      totalJoins: totalJoins,
      fakeClicks: data.fakeClicks || 0,
      conversionRate: conversionRate,
      sentToMeta: data.sentToMeta || 0,
      recentJoins: data.recentJoins || []
    });
  } catch (err) {
    console.error('Stats Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

module.exports = app;
