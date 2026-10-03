const express = require('express');
const admin = require('firebase-admin');
const bizSdk = require('facebook-nodejs-business-sdk');

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

// ---------------- META BUSINESS SDK SETUP ----------------
const ServerEvent = bizSdk.ServerEvent;
const EventRequest = bizSdk.EventRequest;
const UserData = bizSdk.UserData;
const CustomData = bizSdk.CustomData;

// Meta Conversions API (CAPI) Helper - Business SDK use karega
async function sendMetaCapiEvent(userId, userIp, userAgent, fbc) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return false;

  try {
    const userData = (new UserData())
      .setExternalId([String(userId)])  // ARRAY ME DALA - ye fix hai
      .setClientIpAddress(userIp || '0.0.0.0')
      .setClientUserAgent(userAgent || 'Unknown');

    if (fbc) {
      userData.setFbc(fbc);
    }

    const customData = (new CustomData())
      .setCurrency('USD')
      .setValue(1.00)
      .setContentName('Telegram Channel Join');

    const currentTime = Math.floor(Date.now() / 1000);

    const leadEvent = (new ServerEvent())
      .setEventName('Lead')
      .setEventTime(currentTime)
      .setUserData(userData)
      .setCustomData(customData)
      .setActionSource('website');

    const subscribeEvent = (new ServerEvent())
      .setEventName('Subscribe')
      .setEventTime(currentTime)
      .setUserData(userData)
      .setCustomData(customData)
      .setActionSource('website');

    const eventRequest = (new EventRequest(META_ACCESS_TOKEN, META_PIXEL_ID))
      .setEvents([leadEvent, subscribeEvent]);

    const response = await eventRequest.execute();
    console.log('Meta CAPI Response:', response);

    await statsRef.set({
      sentToMeta: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    return true;
  } catch (err) {
    console.error('Meta CAPI Error:', err.message);
    return false;
  }
}

// 1. Track Landing Page Click
app.all('/api/track-click', async (req, res) => {
  try {
    const now = Date.now();

    const newClick = {
      timestamp: now,
      fbclid: req.query.fbclid || req.body.fbclid || '',
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] || ''
    };

    const doc = await statsRef.get();
    const currentData = doc.exists ? doc.data() : {};
    const pendingClicks = currentData.pendingClicks || [];

    // Purane pending clicks (10 minute se zyada purane) ko hata do
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const stillPending = pendingClicks.filter(c => c.timestamp > tenMinutesAgo);
    stillPending.push(newClick);

    await statsRef.set({
      totalClicks: admin.firestore.FieldValue.increment(1),
      pendingClicks: stillPending
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
    let matchedClick = null;

    console.log('Webhook received:', JSON.stringify(update, null, 2));

    // ---- JOIN REQUEST ----
    if (update.chat_join_request) {
      const joinReq = update.chat_join_request;
      const user = joinReq.from;

      const doc = await statsRef.get();
      const currentData = doc.exists ? doc.data() : {};
      const pendingClicks = currentData.pendingClicks || [];

      // Sabse recent click dhoondo
      if (pendingClicks.length > 0) {
        matchedClick = pendingClicks[pendingClicks.length - 1];
        const updatedPending = pendingClicks.filter(c => c.timestamp !== matchedClick.timestamp);
        await statsRef.set({ pendingClicks: updatedPending }, { merge: true });
      }

      userToTrack = {
        userId: user.id,
        name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User',
        username: user.username ? `@${user.username}` : '—',
        source: 'join_request',
        matchedClick: matchedClick
      };
    }

    // ---- MEMBER JOIN ----
    if (update.chat_member) {
      const member = update.chat_member;
      if (['member', 'administrator', 'creator'].includes(member.new_chat_member?.status)) {
        const user = member.new_chat_member.user;

        const doc = await statsRef.get();
        const currentData = doc.exists ? doc.data() : {};
        const pendingClicks = currentData.pendingClicks || [];

        if (pendingClicks.length > 0) {
          matchedClick = pendingClicks[pendingClicks.length - 1];
          const updatedPending = pendingClicks.filter(c => c.timestamp !== matchedClick.timestamp);
          await statsRef.set({ pendingClicks: updatedPending }, { merge: true });
        }

        userToTrack = {
          userId: user.id,
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User',
          username: user.username ? `@${user.username}` : '—',
          source: 'chat_member',
          matchedClick: matchedClick
        };
      }
    }

    // ---- COUNT KARO AUR META KO SIGNAL BHEJO ----
    if (userToTrack) {
      const doc = await statsRef.get();
      const currentData = doc.exists ? doc.data() : {};
      const recentJoins = currentData.recentJoins || [];

      const exists = recentJoins.some(j => String(j.userId) === String(userToTrack.userId));
      if (!exists) {
        const isMetaSent = await sendMetaCapiEvent(
          userToTrack.userId,
          userToTrack.matchedClick ? userToTrack.matchedClick.ip : '0.0.0.0',
          userToTrack.matchedClick ? userToTrack.matchedClick.userAgent : 'TelegramBot',
          userToTrack.matchedClick ? userToTrack.matchedClick.fbclid : null
        );

        userToTrack.joined_at = new Date().toISOString();
        userToTrack.metaStatus = isMetaSent ? 'Sent' : 'Pending';
        userToTrack.sent_to_meta = isMetaSent;

        recentJoins.unshift(userToTrack);
        if (recentJoins.length > 50) recentJoins.pop();

        await statsRef.set({
          totalJoins: admin.firestore.FieldValue.increment(1),
          recentJoins: recentJoins
        }, { merge: true });

        console.log('✅ Join counted for user:', userToTrack.userId);
        console.log('✅ Meta signal sent (Lead + Subscribe):', isMetaSent);
      } else {
        console.log('⚠️ User already counted:', userToTrack.userId);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).send('OK');
  }
});

// 3. Dashboard Stats Endpoint
app.get('/api/stats', async (req, res) => {
  if (req.query.password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const doc = await statsRef.get();
    const data = doc.exists ? doc.data() : {};

    const totalClicks = data.totalClicks || 0;
    const totalJoins = data.totalJoins || 0;
    const fakeClicks = Math.max(0, totalClicks - totalJoins);

    const conversionRate = totalClicks > 0
      ? ((totalJoins / totalClicks) * 100).toFixed(1)
      : '0';

    res.json({
      totalClicks: totalClicks,
      totalJoins: totalJoins,
      fakeClicks: fakeClicks,
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
