const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global state to hold analytics data in Vercel warm containers
global.analyticsData = global.analyticsData || {
  totalClicks: 0,
  totalJoins: 0,
  fakeClicks: 0,
  sentToMeta: 0,
  recentJoins: []
};

const analyticsData = global.analyticsData;
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456';

// Meta Conversions API (CAPI) Helper using built-in fetch
async function sendMetaCapiEvent(userId) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.log('Meta Pixel ID or Access Token is missing.');
    return;
  }
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [{
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'system_generated',
            user_data: { external_id: [String(userId)] }
          }]
        })
      }
    );

    if (response.ok) {
      analyticsData.sentToMeta += 1;
    } else {
      const errData = await response.json();
      console.error('Meta CAPI Error:', errData);
    }
  } catch (err) {
    console.error('Meta CAPI Error:', err.message);
  }
}

// 1. Track Landing Page Click (Support both GET & POST)
app.all('/api/track-click', (req, res) => {
  analyticsData.totalClicks += 1;
  analyticsData.fakeClicks += 1; // Direct independent count
  return res.json({
    success: true,
    totalClicks: analyticsData.totalClicks,
    fakeClicks: analyticsData.fakeClicks
  });
});

// 2. Telegram Webhook Handler
app.post('/api', async (req, res) => {
  try {
    const update = req.body;

    // Handle "Request to Join" (Pending Join Request)
    if (update.chat_join_request) {
      const joinReq = update.chat_join_request;
      const userId = joinReq.from.id;
      const name = `${joinReq.from.first_name || ''} ${joinReq.from.last_name || ''}`.trim() || 'Telegram User';
      const username = joinReq.from.username ? `@${joinReq.from.username}` : '—';

      const exists = analyticsData.recentJoins.some(j => j.userId === userId);
      if (!exists) {
        analyticsData.totalJoins += 1;

        analyticsData.recentJoins.unshift({
          userId: userId,
          name: name,
          username: username,
          joined_at: new Date().toISOString()
        });

        if (analyticsData.recentJoins.length > 50) analyticsData.recentJoins.pop();
        await sendMetaCapiEvent(userId);
      }
      return res.status(200).send('OK');
    }

    // Handle Direct Channel Member Join
    if (update.chat_member) {
      const member = update.chat_member;
      const newStatus = member.new_chat_member?.status;

      if (['member', 'administrator', 'creator'].includes(newStatus)) {
        const user = member.new_chat_member.user;
        const exists = analyticsData.recentJoins.some(j => j.userId === user.id);

        if (!exists) {
          analyticsData.totalJoins += 1;

          analyticsData.recentJoins.unshift({
            userId: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User',
            username: user.username ? `@${user.username}` : '—',
            joined_at: new Date().toISOString()
          });

          if (analyticsData.recentJoins.length > 50) analyticsData.recentJoins.pop();
          await sendMetaCapiEvent(user.id);
        }
      }
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).send('OK');
  }
});

// 3. Dashboard Data Stats Endpoint (Instant updates with No-Cache)
app.get('/api/stats', (req, res) => {
  if (req.query.password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Prevent browser & serverless caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const conversionRate = analyticsData.totalClicks > 0
    ? ((analyticsData.totalJoins / analyticsData.totalClicks) * 100).toFixed(1)
    : '0';

  res.json({
    totalClicks: analyticsData.totalClicks,
    totalJoins: analyticsData.totalJoins,
    fakeClicks: analyticsData.fakeClicks,
    conversionRate: conversionRate,
    sentToMeta: analyticsData.sentToMeta,
    recentJoins: analyticsData.recentJoins
  });
});

module.exports = app;
