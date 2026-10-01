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

// SIRF INVITE HASH CHECK KARO (exact link nahi)
const MY_INVITE_HASH = 'V_OjtSP5zfM0ZGQ8';

// Meta Conversions API (CAPI) Helper
async function sendMetaCapiEvent(userId, userIp, userAgent, fbc) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return false;
  
  try {
    const userData = {
      external_id: [String(userId)],
      client_ip_address: userIp || '0.0.0.0',
      client_user_agent: userAgent || 'Unknown'
    };

    if (fbc) {
      userData.fbc = fbc;
    }

    const payload = {
      data: [
        {
          event_name: 'Subscribe',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          user_data: userData,
          custom_data: {
            currency: 'USD',
            value: 1.00,
            content_name: 'Telegram Channel Join'
          }
        }
      ]
    };

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();
    console.log('Meta CAPI Response:', data);

    if (response.ok && data.events_received) {
      await statsRef.set({
        sentToMeta: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
      return true;
    }
  } catch (err) {
    console.error('Meta CAPI Error:', err.message);
  }
  return false;
}

// 1. Track Landing Page Click
app.all('/api/track-click', async (req, res) => {
  try {
    await statsRef.set({
      totalClicks: admin.firestore.FieldValue.increment(1)
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

    // ---- CASE 1: JOIN REQUEST ----
    if (update.chat_join_request) {
      const joinReq = update.chat_join_request;
      
      // Join request me invite_link nahi hota, isliye hum isko
      // tabhi count karenge jab user ne actual join kiya ho
      // Lekin kuch cases me chat_member update nahi aata, isliye
      // hum join request ko bhi track kar sakte hain (optional)
      
      console.log('Join request received from user:', joinReq.from.id);
      
      // Agar aap chahte ho ki join request par bhi count ho, to
      // neeche wala code uncomment karo:
      /*
      userToTrack = {
        userId: joinReq.from.id,
        name: `${joinReq.from.first_name || ''} ${joinReq.from.last_name || ''}`.trim() || 'Telegram User',
        username: joinReq.from.username ? `@${joinReq.from.username}` : '—',
        source: 'join_request'
      };
      */
    }

    // ---- CASE 2: ACTUAL MEMBER JOIN ----
    if (update.chat_member) {
      const member = update.chat_member;
      
      if (['member', 'administrator', 'creator'].includes(member.new_chat_member?.status)) {
        const user = member.new_chat_member.user;
        const inviteLink = member.invite_link?.invite_link || '';
        
        console.log('User joined. Invite link:', inviteLink);
        
        // SIRF HASH CHECK KARO (exact link nahi)
        if (inviteLink && inviteLink.includes(MY_INVITE_HASH)) {
          console.log('✅ User joined via MY landing page link');
          userToTrack = {
            userId: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User',
            username: user.username ? `@${user.username}` : '—',
            source: 'chat_member'
          };
        } else {
          console.log('❌ User joined via different link:', inviteLink);
        }
      }
    }

    // ---- COUNT KARO ----
    if (userToTrack) {
      const doc = await statsRef.get();
      const currentData = doc.exists ? doc.data() : {};
      const recentJoins = currentData.recentJoins || [];

      const exists = recentJoins.some(j => String(j.userId) === String(userToTrack.userId));
      if (!exists) {
        const isMetaSent = await sendMetaCapiEvent(userToTrack.userId, '0.0.0.0', 'TelegramBot', null);

        userToTrack.joined_at = new Date().toISOString();
        userToTrack.metaStatus = isMetaSent ? 'Sent' : 'Pending';

        recentJoins.unshift(userToTrack);
        if (recentJoins.length > 50) recentJoins.pop();

        await statsRef.set({
          totalJoins: admin.firestore.FieldValue.increment(1),
          recentJoins: recentJoins
        }, { merge: true });

        console.log('✅ Join counted for user:', userToTrack.userId);
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
