// ===================== BACKEND =====================
require('dotenv').config();
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const cors = require('cors');
const session = require('express-session');

const app = express();

// ------------------- SESSION SETUP -------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'flowtune_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false } // true if HTTPS
}));

// ------------------- CORS -------------------
app.use(cors({
  origin: 'https://flowtune.vercel.app', // your frontend URL
  credentials: true
}));

app.use(express.json());

// ------------------- SPOTIFY APP CLIENT -------------------
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI
});

// ------------------- APP TOKEN -------------------
async function refreshAppToken() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    console.log('✅ App token refreshed');
  } catch (err) {
    console.error('❌ Failed to refresh app token', err);
  }
}
refreshAppToken();
setInterval(refreshAppToken, 50 * 60 * 1000);

// ------------------- USER AUTH -------------------
app.get('/login', (req, res) => {
  const scopes = ['playlist-modify-private', 'playlist-modify-public'];
  const url = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const data = await spotifyApi.authorizationCodeGrant(code);

    req.session.access_token = data.body['access_token'];
    req.session.refresh_token = data.body['refresh_token'];

    console.log('✅ User logged in');
    res.send('Login successful! Return to FlowTune frontend.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication failed');
  }
});

// ------------------- REFRESH USER API -------------------
async function getUserApi(req) {
  if (!req.session.access_token) return null;

  const userApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.REDIRECT_URI
  });

  userApi.setAccessToken(req.session.access_token);
  userApi.setRefreshToken(req.session.refresh_token);

  try {
    const data = await userApi.refreshAccessToken();
    userApi.setAccessToken(data.body['access_token']);
    req.session.access_token = data.body['access_token'];
  } catch (err) {
    console.error('⚠️ Token refresh failed', err);
  }

  return userApi;
}

// ------------------- DJ LOGIC -------------------
function keyCompatibility(a, b) {
  if (a.key === b.key) return 1;
  const diff = Math.abs(a.key - b.key);
  if (diff === 1 || diff === 11) return 0.8;
  return 0;
}

function targetEnergy(step, total) {
  return 0.5 + (step / total) * 0.4;
}

function djScore(current, candidate, step, total) {
  const tempoScore = 1 - Math.min(Math.abs(current.tempo - candidate.tempo) / 6, 1);
  const energyScore = 1 - Math.abs(candidate.energy - targetEnergy(step, total));
  const danceScore = 1 - Math.abs(current.danceability - candidate.danceability);
  const valenceScore = 1 - Math.abs(current.valence - candidate.valence);
  const keyScore = keyCompatibility(current, candidate);
  return tempoScore * 2 + energyScore * 2 + danceScore + valenceScore + keyScore * 2;
}

// ------------------- SEARCH -------------------
app.get('/search', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'No name provided' });

    const data = await spotifyApi.searchTracks(name, { limit: 1 });
    if (!data.body.tracks.items.length) return res.json({ track_id: null });

    res.json({ track_id: data.body.tracks.items[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ------------------- GENERATE FLOW -------------------
app.get('/generate_flow', async (req, res) => {
  try {
    const { track_id } = req.query;
    if (!track_id) return res.status(400).json({ error: 'No track_id provided' });

    const totalTracks = 12;
    const startFeatures = await spotifyApi.getAudioFeaturesForTrack(track_id);
    let current = startFeatures.body;

    let used = new Set([track_id]);
    let playlist = [];

    for (let step = 0; step < totalTracks; step++) {
      const recData = await spotifyApi.getRecommendations({
        seed_tracks: [track_id],
        limit: 30
      });

      const tracks = recData.body.tracks.filter(t => !used.has(t.id));
      const ids = tracks.map(t => t.id);
      const featuresData = await spotifyApi.getAudioFeaturesForTracks(ids);

      let best = null;
      let bestScore = -Infinity;

      tracks.forEach((track, i) => {
        const f = featuresData.body.audio_features[i];
        if (!f) return;
        const score = djScore(current, f, step, totalTracks);
        if (score > bestScore) {
          bestScore = score;
          best = { track, features: f };
        }
      });

      if (!best) break;

      playlist.push(best.track);
      used.add(best.track.id);
      current = best.features;
    }

    res.json({
      playlist: playlist.map(t => ({
        id: t.id,
        name: t.name,
        artists: t.artists.map(a => a.name).join(', '),
        album: t.album.name,
        albumArt: t.album.images[0]?.url,
        preview_url: t.preview_url
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Flow generation failed' });
  }
});

// ------------------- SAVE PLAYLIST -------------------
app.post('/save_playlist', async (req, res) => {
  try {
    const userApi = await getUserApi(req);
    if (!userApi) return res.status(401).json({ error: 'Not logged in' });

    const me = await userApi.getMe();
    const playlist = await userApi.createPlaylist(me.body.id, {
      name: 'FlowTune Playlist',
      description: 'Generated by FlowTune',
      public: false
    });

    const { tracks } = req.body;
    if (!tracks || !tracks.length) return res.status(400).json({ error: 'No tracks provided' });

    await userApi.addTracksToPlaylist(
      playlist.body.id,
      tracks.map(id => `spotify:track:${id}`)
    );

    res.json({ success: true, playlist_url: playlist.body.external_urls.spotify });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎧 FlowTune backend running on https://flowtune-tbgc.onrender.com`));