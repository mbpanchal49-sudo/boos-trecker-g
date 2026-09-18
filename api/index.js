const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment Variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456';

// In-Memory Database (Aap isse Firebase se replace kar sakte ho)
let analyticsData = {
  totalClicks: 0,
  totalJoins: 0,
  fakeClicks: 0,
  sentToMeta: 0,
  recentJoins: []
};

// Meta CAPI Event Sending Function
async function sendMetaCapiEvent(userId, userDetails = {}) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.log('Meta Credentials missing, skipping CAPI.');
    return;
  }

  try {
    const payload = {
      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'system_generated',
          user_data: {
            external_id: [String(userId)]
          }
        }
      ]
    };

    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
      payload
    );

    if (response.data) {
      analyticsData.sentToMeta += 1;
      console.log('Meta CAPI Success:', response.data);
    }
  } catch (err) {
    console.error('Meta CAPI Error:', err.response?.data || err.message);
  }
}

// 1. Click Tracking Route (Landing Page se click count karne ke liye)
app.get('/api/track-click', (req, res) => {
  analyticsData.totalClicks += 1;
  analyticsData.fakeClicks = Math.max(0, analyticsData.totalClicks - analyticsData.totalJoins);
  res.json({ success: true, totalClicks: analyticsData.totalClicks });
});

// 2. Telegram Webhook Endpoint
app.post('/api', async (req, res) => {
  try {
    const update = req.body;

    // CASE A: User "Request to Join" karta he (Without Auto-Approve)
    if (update.chat_join_request) {
      const joinReq = update.chat_join_request;
      const userId = joinReq.from.id;
      const name = `${joinReq.from.first_name || ''} ${joinReq.from.last_name || ''}`.trim() || 'Telegram User';
      const username = joinReq.from.username ? `@${joinReq.from.username}` : '—';

      // Check if user already counted
      const alreadyJoined = analyticsData.recentJoins.some(j => j.userId === userId);
      
      if (!alreadyJoined) {
        analyticsData.totalJoins += 1;
        analyticsData.fakeClicks = Math.max(0, analyticsData.totalClicks - analyticsData.totalJoins);

        analyticsData.recentJoins.unshift({
          userId: userId,
          name: name,
          username: username,
          joined_at: new Date().toISOString(),
          source: 'meta_ads',
          sent_to_meta: true
        });

        // Top 50 recent joins maintain rakhein
        if (analyticsData.recentJoins.length > 50) {
          analyticsData.recentJoins.pop();
        }

        // Meta CAPI Send
        await sendMetaCapiEvent(userId);
      }

      return res.status(200).send('OK');
    }

    // CASE B: Direct Member Join Event (Normal Public/Invite Link)
    if (update.chat_member) {
      const member = update.chat_member;
      const newStatus = member.new_chat_member?.status;

      if (['member', 'administrator', 'creator'].includes(newStatus)) {
        const user = member.new_chat_member.user;
        const userId = user.id;
        const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Telegram User';
        const username = user.username ? `@${user.username}` : '—';

        const alreadyJoined = analyticsData.recentJoins.some(j => j.userId === userId);

        if (!alreadyJoined) {
          analyticsData.totalJoins += 1;
          analyticsData.fakeClicks = Math.max(0, analyticsData.totalClicks - analyticsData.totalJoins);

          analyticsData.recentJoins.unshift({
            userId: userId,
            name: name,
            username: username,
            joined_at: new Date().toISOString(),
            source: 'meta_ads',
            sent_to_meta: true
          });

          if (analyticsData.recentJoins.length > 50) {
            analyticsData.recentJoins.pop();
          }

          await sendMetaCapiEvent(userId);
        }
      }
      return res.status(200).send('OK');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Handling Error:', err);
    res.status(200).send('OK');
  }
});

// 3. Dashboard API Stats Route
app.get('/api/stats', (req, res) => {
  const pass = req.query.password;
  if (pass !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
