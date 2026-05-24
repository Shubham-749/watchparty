/**
 * room.js — WebSocket client for the WatchParty room page
 *
 * FR-02: Applies host PLAY/PAUSE/SEEK to the YouTube IFrame player
 * FR-03: Handles CATCHUP message → seeks to current position on join
 * FR-04: Role-gates controls (host shows controls bar; guest sees message)
 * FR-05: Queue management — add, upvote, remove entries
 * FR-06: Skip vote — majority-based skip mechanic
 * FR-07: Handles HOST_PROMOTED → unlocks controls if this client is promoted
 */
'use strict';

// ── Session credentials (written by main.js) ──────────────────────────────
const roomId      = new URLSearchParams(location.search).get('roomId');
const token       = new URLSearchParams(location.search).get('token');
const userId      = sessionStorage.getItem('wp_userId');
const displayName = sessionStorage.getItem('wp_displayName') ?? 'Guest';

let role      = sessionStorage.getItem('wp_role') ?? 'guest';
let inviteLink = sessionStorage.getItem('wp_inviteLink') ?? location.href;

// Guard: missing credentials → redirect home
if (!roomId || !userId) {
  location.replace(`/?roomId=${roomId ?? ''}&token=${token ?? ''}`);
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const roomIdDisplay  = $('room-id-display');
const roleBadge      = $('role-badge');
const memberList     = $('member-list');
const memberCount    = $('member-count');
const emptyState     = $('empty-state');
const emptyHint      = $('empty-state-hint');
const playerArea     = $('player-area');
const videoShell     = $('video-shell');
const videoFrame     = $('video-frame');
const guestOverlay   = $('guest-overlay');
const urlSection     = $('url-section');
const urlInput       = $('url-input');
const hostControls   = $('host-controls');
const hostSeek       = $('host-seek');
const guestMsg       = $('guest-msg');
const btnPlayPause   = $('btn-play-pause');
const seekBar        = $('seek-bar');
const timeCurrent    = $('time-current');
const timeTotal      = $('time-total');
const inviteDisplay  = $('invite-display');

// Queue DOM refs (FR-05)
const queueUrlInput  = $('queue-url-input');
const queueList      = $('queue-list');
const queueEmpty     = $('queue-empty');
const queueCount     = $('queue-count');

// Skip DOM refs (FR-06)
const skipSection    = $('skip-section');
const skipProgress   = $('skip-progress');

// Chat DOM refs (FR-10)
const chatMessages   = $('chat-messages');
const chatInput      = $('chat-input');
const chatEmpty      = $('chat-empty');

// Display Name refs (FR-08)
const nameInput      = $('name-input');

// ── Toast helper ──────────────────────────────────────────────────────────
function toast(message, type = 'info', durationMs = 3500) {
  const icons = { error: '❌', success: '✅', info: 'ℹ️', warn: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] ?? 'ℹ️'}</span><span>${message}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut 400ms ease forwards';
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, durationMs);
}

// ── Sidebar Tab Switcher ──────────────────────────────────────────────────
function switchSidebarTab(tab) {
  ['room', 'chat', 'queue'].forEach(t => {
    $(`stab-${t}`).classList.toggle('active', t === tab);
    $(`stab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`spanel-${t}`).classList.toggle('active', t === tab);
  });
  // Auto-scroll chat to bottom when switching to chat tab
  if (tab === 'chat' && chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// ── Role UI ───────────────────────────────────────────────────────────────
function applyRoleUI() {
  const isHost = role === 'host' || role === 'co-host';

  roleBadge.className = `badge badge-${role === 'host' ? 'host' : role === 'co-host' ? 'cohost' : 'guest'}`;
  roleBadge.textContent = role === 'host' ? '👑 Host' : role === 'co-host' ? '⭐ Co-Host' : '👤 Guest';

  urlSection.classList.toggle('hidden', !isHost);
  hostControls.classList.toggle('hidden', !isHost);
  hostSeek.classList.toggle('hidden', !isHost);
  guestMsg.classList.toggle('hidden',  isHost);
  updateGuestOverlay();
}

function updateGuestOverlay() {
  const isHost = role === 'host' || role === 'co-host';
  guestOverlay.classList.toggle('hidden', isHost);
}

// ── Invite link display ───────────────────────────────────────────────────
function showInviteLink() {
  roomIdDisplay.textContent = roomId.slice(0, 8) + '…';
  inviteDisplay.textContent = inviteLink;
}

// ── Catch-up flash ────────────────────────────────────────────────────────
function showCatchupFlash() {
  const el = document.createElement('div');
  el.className = 'catchup-flash';
  el.textContent = '⏩ Caught up to live position';
  const playerArea = document.querySelector('.player-area');
  playerArea?.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// ── Time formatting ───────────────────────────────────────────────────────
function fmt(s) {
  s = Math.floor(s ?? 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ══════════════════════════════════════════════════════════════════════════
// YouTube IFrame Player
// ══════════════════════════════════════════════════════════════════════════
let ytPlayer       = null;
let ytReady        = false;
let seekPending    = false;  // user is actively dragging
let poller         = null;   // seek-bar update interval
let syncVerificationTimer = null;  // verify guest sync (NEW)
let endedReportedForCurrentVideo = false;
let playerReady    = false;
let playerVideoReady = false;
let playerSeekable = false;  // can actually seek (NEW)
let activeVideoId  = null;
let pendingVideoId = null;
let pendingPlayerState = null;
let pendingCatchupFlash = false;
let pendingRetryTimer = null;  // retry backoff timer (NEW)
let pendingRetryCount = 0;     // retry attempt counter (NEW)
const MAX_RETRIES = 5;         // max retry attempts (NEW)
let lastCommandType = null;    // last broadcast command type (NEW)
let commandSuppressUntil = 0;  // suppress window based on command (NEW)
let lastPolledPosition = 0;
let lastPollTs = 0;
let lastBroadcastSeekAt = 0;
let lastIdleCheckAt = 0;       // track idle for periodic sync (NEW)
let lastServerSync = 0;        // track last full server sync (NEW)
let lastKnownServerSequence = 0;  // track command sequence for verification (NEW)
const KEYBOARD_SEEK_STEP_SECONDS = 5;
const DRIFT_THRESHOLD_SMALL = 0.5;  // small drift always broadcasts (NEW)
const DRIFT_THRESHOLD_LARGE = 1.5;  // large drift broadcasts (NEW)
const SUPPRESS_WINDOW_SHORT = 400;  // short suppress for same command (NEW)
const SYNC_VERIFY_INTERVAL = 10000;  // verify sync every 10s (NEW)
const ALLOWED_SYNC_DRIFT = 0.5;  // max allowed drift before resync (NEW)

// Called by YouTube IFrame API when script loads
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  maybeLoadPendingVideo();
};

function extractYouTubeVideoId(rawUrl) {
  if (!rawUrl) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(rawUrl)) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1) || null;
    }

    if (url.searchParams.get('v')) {
      return url.searchParams.get('v');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const embedIndex = parts.indexOf('embed');
    if (embedIndex !== -1 && parts[embedIndex + 1]) {
      return parts[embedIndex + 1];
    }
  } catch {
    return null;
  }

  return null;
}

function syncPlayerSnapshot() {
  if (!ytPlayer || !playerReady) return;

  try {
    const currentTime = ytPlayer.getCurrentTime();
    const duration = ytPlayer.getDuration();

    if (Number.isFinite(currentTime) && currentTime >= 0) {
      localPosition = currentTime;
    }
    if (Number.isFinite(duration) && duration > 0) {
      localDuration = duration;
    }
  } catch {
    return;
  }

  updateSeekBar();
  updateTimestamp();
}

function getPlayerTime() {
  if (!ytPlayer || !playerReady) {
    console.warn("[PlayerTime] Fallback → player not ready", {
      ytPlayer: !!ytPlayer,
      playerReady,
      localPosition
    });
    return localPosition;
  }

  try {
    const currentTime = ytPlayer.getCurrentTime();

    if (Number.isFinite(currentTime) && currentTime >= 0) {
      return currentTime;
    }

    console.warn("[PlayerTime] Fallback → invalid time from player", {
      currentTime,
      localPosition
    });
    return localPosition;

  } catch (err) {
    console.warn("[PlayerTime] Fallback → exception", {
      error: err,
      localPosition
    });
    return localPosition;
  }
}

function getPlayerDuration() {
  if (!ytPlayer || !playerReady) {
    console.warn("[PlayerDuration] Fallback → player not ready", {
      ytPlayer: !!ytPlayer,
      playerReady,
      localDuration
    });
    return localDuration;
  }

  try {
    const duration = ytPlayer.getDuration();

    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }

    console.warn("[PlayerDuration] Fallback → invalid duration", {
      duration,
      localDuration
    });
    return localDuration;

  } catch (err) {
    console.warn("[PlayerDuration] Fallback → exception", {
      error: err,
      localDuration
    });
    return localDuration;
  }
}

function isHostController() {
  return role === 'host' || role === 'co-host';
}

function shouldBroadcastHostControl() {
  return isHostController() &&
    ws?.readyState === WebSocket.OPEN &&
    Date.now() > suppressHostBroadcastUntil;
}

function suppressHostBroadcast(ms = SUPPRESS_WINDOW_SHORT) {
  commandSuppressUntil = Math.max(commandSuppressUntil, Date.now() + ms);
}

function shouldSuppressBroadcast(commandType) {
  // Only suppress if same command type within suppress window
  return lastCommandType === commandType && Date.now() < commandSuppressUntil;
}

function broadcastHostPlayback(type, position = getPlayerTime()) {
  if (!shouldBroadcastHostControl()) return false;
  lastCommandType = type;
  commandSuppressUntil = Date.now() + SUPPRESS_WINDOW_SHORT;
  logSync(`[BROADCAST] type=${type} position=${position.toFixed(1)}s`);
  return sendWs({ type, position });
}

function canApplyPlayerState() {
  return ytPlayer && playerReady && playerVideoReady && playerSeekable;
}

function flushPendingPlayerState() {
  if (!pendingPlayerState) return;
  if (!canApplyPlayerState()) {
    // Schedule retry with exponential backoff
    if (!pendingRetryTimer) {
      const delay = Math.pow(2, pendingRetryCount) * 100; // 100ms, 200ms, 400ms...
      if (pendingRetryCount < MAX_RETRIES) {
        logSync(`[RETRY] Scheduling retry ${pendingRetryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
        pendingRetryCount++;
        pendingRetryTimer = setTimeout(() => {
          pendingRetryTimer = null;
          flushPendingPlayerState();
        }, delay);
      } else {
        logSync(`[ERROR] Max retries reached for state:`, pendingPlayerState);
        pendingPlayerState = null;
        pendingRetryCount = 0;
      }
    }
    return;
  }

  const nextState = pendingPlayerState;
  pendingPlayerState = null;
  pendingRetryCount = 0;
  if (pendingRetryTimer) {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }

  try {
    if (typeof nextState.position === 'number' && Number.isFinite(nextState.position)) {
      const pos = Math.max(0, Math.min(nextState.position, localDuration));
      logSync(`[SEEK-APPLY] Seeking to ${pos.toFixed(1)}s`);
      ytPlayer.seekTo(pos, true);
      localPosition = pos;
    }

    if (nextState.status === 'playing') {
      logSync(`[PLAY-APPLY]`);
      ytPlayer.playVideo();
    } else if (nextState.status === 'paused') {
      logSync(`[PAUSE-APPLY]`);
      ytPlayer.pauseVideo();
    }
  } catch (err) {
    logSync(`[ERROR] Failed to apply state:`, err.message);
    pendingPlayerState = nextState;
    return;
  }

  suppressHostBroadcast();
  syncPlayerSnapshot();

  if (pendingCatchupFlash) {
    pendingCatchupFlash = false;
    showCatchupFlash();
  }
}

function queuePlayerState(nextState, options = {}) {
  pendingPlayerState = { ...(pendingPlayerState ?? {}), ...nextState };
  if (options.showCatchupFlash) {
    pendingCatchupFlash = true;
  }
  flushPendingPlayerState();
}

function handlePlayerReady(event) {
  playerReady = true;
  playerVideoReady = true;
  playerSeekable = true;  // Player is ready to seek
  pendingVideoId = null;
  const iframe = videoFrame?.querySelector('iframe');
  iframe?.setAttribute('tabindex', '-1');
  logSync(`[PLAYER-READY]`);
  startSeekPoller();
  syncPlayerSnapshot();
  lastPolledPosition = getPlayerTime();
  lastPollTs = Date.now();
  lastIdleCheckAt = Date.now();
  flushPendingPlayerState();

  // Give player a moment to stabilize before applying pending state
  setTimeout(() => {
    if (pendingPlayerState) {
      logSync(`[DEFERRED-FLUSH] Applying deferred state after stabilization`);
      flushPendingPlayerState();
    }
  }, 100);

  // If a newer load request arrived while the API was initialising, honour it now.
  if (activeVideoId && extractYouTubeVideoId(event.target.getVideoUrl?.() ?? '') !== activeVideoId) {
    pendingVideoId = activeVideoId;
    playerVideoReady = false;
    playerSeekable = false;
    maybeLoadPendingVideo();
  }
}

function handlePlayerStateChange(event) {
  const state = event.data;
  const prevStatus = localStatus;
  const stateNames = {
    [-1]: 'UNSTARTED',
    [0]: 'ENDED',
    [1]: 'PLAYING',
    [2]: 'PAUSED',
    [3]: 'BUFFERING',
    [5]: 'CUED'
  };

  logSync(`[STATE-CHANGE] ${stateNames[state] || state}`);

  if (state === YT.PlayerState.CUED ||
      state === YT.PlayerState.PLAYING ||
      state === YT.PlayerState.PAUSED ||
      state === YT.PlayerState.BUFFERING) {
    playerVideoReady = true;
    playerSeekable = true;
    syncPlayerSnapshot();
    flushPendingPlayerState();
  }

  if (state === YT.PlayerState.PLAYING) {
    localStatus = 'playing';
    endedReportedForCurrentVideo = false;
    btnPlayPause.textContent = '⏸';
  } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED) {
    if (localStatus !== 'ended') {
      localStatus = 'paused';
    }
    btnPlayPause.textContent = '▶';
  } else if (state === YT.PlayerState.ENDED) {
    localStatus = 'ended';
    btnPlayPause.textContent = '▶';

    if (!endedReportedForCurrentVideo) {
      endedReportedForCurrentVideo = true;
      logSync(`[VIDEO-ENDED]`);
      onVideoEnded();
    }
  }

  syncPlayerSnapshot();

  if (state === YT.PlayerState.PLAYING && prevStatus !== 'playing') {
    logSync(`[PLAY-DETECTED] Broadcasting play`);
    broadcastHostPlayback('PLAY');
  } else if (state === YT.PlayerState.PAUSED && prevStatus === 'playing') {
    logSync(`[PAUSE-DETECTED] Broadcasting pause`);
    broadcastHostPlayback('PAUSE');
  }
}

function handlePlayerError(event) {
  console.error('[room.js] YT player error', event.data);
  toast('Could not load this YouTube video.', 'error');
}

function maybeLoadPendingVideo() {
  if (!ytReady || !pendingVideoId) return;

  if (!ytPlayer) {
    activeVideoId = pendingVideoId;
    logSync(`[INIT-PLAYER] Creating YouTube player for ${activeVideoId}`);
    ytPlayer = new window.YT.Player('video-frame', {
      width: '100%',
      height: '100%',
      videoId: activeVideoId,
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        rel: 0,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        playsinline: 1,
        origin: location.origin,
      },
      events: {
        onReady: handlePlayerReady,
        onStateChange: handlePlayerStateChange,
        onError: handlePlayerError,
      },
    });
    return;
  }

  if (!playerReady) return;

  activeVideoId = pendingVideoId;
  pendingVideoId = null;
  playerVideoReady = false;
  playerSeekable = false;
  logSync(`[CUE-VIDEO] Cueing ${activeVideoId}`);

  try {
    ytPlayer.cueVideoById({
      videoId: activeVideoId,
      startSeconds: 0,
    });
  } catch (err) {
    logSync(`[ERROR] Failed to cue video: ${err.message}`);
  }
}

function createPlayer(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    toast('Only YouTube videos are supported right now.', 'error');
    return false;
  }

  logSync(`[CREATE-PLAYER] Loading video ${videoId}`);
  emptyState.classList.add('hidden');
  videoShell.classList.remove('hidden');
  endedReportedForCurrentVideo = false;
  playerVideoReady = false;
  playerSeekable = false;
  pendingVideoId = videoId;
  activeVideoId = videoId;
  lastPolledPosition = 0;
  lastPollTs = Date.now();
  lastBroadcastSeekAt = 0;
  lastIdleCheckAt = Date.now();
  lastServerSync = 0;

  // Destroy existing polling
  if (poller) clearInterval(poller);
  if (pendingRetryTimer) {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }
  if (syncVerificationTimer) {
    clearInterval(syncVerificationTimer);
    syncVerificationTimer = null;
  }

  maybeLoadPendingVideo();
  startSeekPoller();
  startSyncVerification();  // Start verifying guest sync
  
  // Focus player for keyboard input with retries
  setTimeout(() => {
    videoShell?.focus();
    playerArea?.focus();
    logSync(`[FOCUS-INIT] Set focus to video elements`);
  }, 100);
  
  // Create click blocker overlay for hosts
  createClickBlocker();
  
  return true;
}

function createClickBlocker() {
  if (!isHostController()) return;
  
  // Create transparent overlay to block YouTube's click pause/play
  let blocker = document.getElementById('video-click-blocker');
  if (blocker) blocker.remove();
  
  blocker = document.createElement('div');
  blocker.id = 'video-click-blocker';
  blocker.style.cssText = `
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: transparent;
    z-index: 1;
    pointer-events: auto;
    cursor: default;
  `;
  
  // Prevent default click actions
  blocker.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    logSync(`[CLICK-BLOCKED] Click intercepted on video`);
  }, true);
  
  blocker.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    logSync(`[DBLCLICK-BLOCKED] Double-click intercepted`);
  }, true);
  
  videoShell?.appendChild(blocker);
  logSync(`[CLICK-BLOCKER] Created for host`);
}

function startSeekPoller() {
  if (poller) clearInterval(poller);
  poller = setInterval(() => {
    if (!ytPlayer || !playerReady || !playerVideoReady || seekPending) return;
    syncPlayerSnapshot();

    const now = Date.now();
    const current = getPlayerTime();
    const elapsedSec = lastPollTs ? (now - lastPollTs) / 1000 : 0;
    const expected = localStatus === 'playing'
      ? lastPolledPosition + elapsedSec
      : lastPolledPosition;
    const drift = Math.abs(current - expected);

    // Broadcast if:
    // 1. Large drift detected AND not suppressing same command
    // 2. Small drift always broadcasts if not suppressing
    // 3. Idle threshold: no command in 5s, send position update
    const isSuppressed = shouldSuppressBroadcast('SEEK');
    const timeSinceLastBroadcast = now - lastBroadcastSeekAt;
    const isIdleUpdate = now - lastIdleCheckAt > 5000;

    if (shouldBroadcastHostControl()) {
      if ((drift > DRIFT_THRESHOLD_LARGE && !isSuppressed && timeSinceLastBroadcast > 400) ||
          (drift > DRIFT_THRESHOLD_SMALL && timeSinceLastBroadcast > 1000) ||
          (isIdleUpdate && localStatus === 'playing')) {
        lastBroadcastSeekAt = now;
        lastIdleCheckAt = now;
        logSync(`[DRIFT] ${drift.toFixed(1)}s, broadcasting SEEK`);
        broadcastHostPlayback('SEEK', current);
      }
    }

    lastPolledPosition = current;
    lastPollTs = now;
  }, 500);
}

// ──────────────────────────────────────────────────────────────────────────
// Local playback state tracking (used for seek bar, re-broadcast on rejoin)
// ──────────────────────────────────────────────────────────────────────────
let localPosition  = 0;
let localStatus    = 'paused';
let localDuration  = 0;  // set once known

function updateSeekBar() {
  if (seekPending || !localDuration) return;
  const pct = (localPosition / localDuration) * 100;
  seekBar.value = pct;
  seekBar.style.setProperty('--progress', `${pct}%`);
  timeCurrent.textContent = fmt(localPosition);
  timeTotal.textContent   = fmt(localDuration);
}

function updateTimestamp() {
  timeCurrent.textContent = fmt(localPosition);
}

/**
 * FR-05: When the current video ends, notify the server to auto-play next.
 */
function onVideoEnded() {
  if (role === 'host' || role === 'co-host') {
    sendWs({ type: 'VIDEO_ENDED' });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WebSocket Connection
// ══════════════════════════════════════════════════════════════════════════
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?roomId=${roomId}&token=${token}`;
let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT   = 5;

function logSync(...args) {
  console.info('[room.js]', ...args);
}

function sendWs(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[room.js] WS send skipped; socket not open yet', message);
    toast('Connection is still starting. Try again in a moment.', 'warn', 2500);
    return false;
  }

  ws.send(JSON.stringify(message));
  logSync('sent', message);
  return true;
}

function connect() {
  logSync('connecting to', WS_URL);
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    logSync('socket open');
    sendWs({ type: 'JOIN', roomId, userId, role, displayName });
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    logSync('received', msg);
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    logSync('socket closed');
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(500 * 2 ** reconnectAttempts, 10_000);
      toast(`Connection lost — reconnecting in ${Math.round(delay/1000)}s…`, 'warn', delay);
      setTimeout(connect, delay);
    } else {
      toast('Could not reconnect. Please refresh.', 'error', 10_000);
    }
  });

  ws.addEventListener('error', (e) => {
    console.error('[room.js] WS error', e);
  });
}

// ── Incoming message handler ──────────────────────────────────────────────
function handleMessage(msg) {
  logSync(`[RCV-${msg.type}]`, msg);
  
  switch (msg.type) {

    // FR-03: Late-join catch-up
    case 'CATCHUP':
      logSync(`[CATCHUP] position=${msg.position}, status=${msg.status}`);
      localPosition = msg.position ?? 0;
      localStatus   = msg.status   ?? 'paused';
      if (msg.url) {
        if (createPlayer(msg.url)) {
          queuePlayerState(
            { position: localPosition, status: localStatus },
            { showCatchupFlash: true }
          );
        }
      }
      updateSeekBar();
      break;

    // FR-02: Playback sync
    case 'PLAY':
      logSync(`[PLAY] position=${msg.position}`);
      localPosition = msg.position ?? localPosition;
      localStatus   = 'playing';
      queuePlayerState({ position: localPosition, status: 'playing' });
      btnPlayPause.textContent = '⏸';
      break;

    case 'PAUSE':
      logSync(`[PAUSE] position=${msg.position}`);
      localPosition = msg.position ?? localPosition;
      localStatus   = 'paused';
      queuePlayerState({ position: localPosition, status: 'paused' });
      btnPlayPause.textContent = '▶';
      break;

    case 'SEEK':
      logSync(`[SEEK] position=${msg.position}`);
      localPosition = msg.position ?? localPosition;
      queuePlayerState({ position: localPosition });
      updateSeekBar();
      break;

    // New video loaded by host
    case 'LOAD':
      logSync(`[LOAD] url=${msg.url}`);
      if (!createPlayer(msg.url)) break;
      localPosition = 0;
      localStatus   = 'paused';
      endedReportedForCurrentVideo = false;
      queuePlayerState({ position: 0, status: 'paused' });
      updateSeekBar();
      break;

    // FR-07: This client is promoted to host
    case 'HOST_PROMOTED':
      logSync(`[HOST-PROMOTED] userId=${msg.userId}`);
      if (msg.userId === userId) {
        role = msg.role ?? 'host';
        applyRoleUI();
        toast('You are now the host!', 'success');
      }
      break;

    // Member list update (NFR-05: show who's in the room)
    case 'MEMBER_LIST':
      renderMembers(msg.members ?? []);
      break;

    // FR-05: Queue update
    case 'QUEUE_UPDATE':
      renderQueue(msg.queue ?? []);
      break;

    // FR-06: Skip vote status
    case 'SKIP_STATUS':
      updateSkipProgress(msg.count ?? 0, msg.needed ?? 0);
      break;

    // FR-10: Chat message received
    case 'CHAT_MSG':
      renderChatMessage(msg);
      break;

    // FR-10: Emoji reaction received
    case 'CHAT_REACTION':
      renderChatReaction(msg);
      break;

    // FR-10: Chat history for late joiners
    case 'CHAT_HISTORY':
      renderChatHistory(msg.messages ?? []);
      break;

    // FR-05: Queue is empty (no next video)
    case 'QUEUE_EMPTY':
      toast('Queue is empty — no next video.', 'info');
      break;

    case 'ERROR':
      logSync(`[ERROR-MSG] ${msg.message}`);
      toast(msg.message, 'error');
      break;
    
    // Sync verification from guests (host only)
    case 'SYNC_CHECK':
      handleSyncCheck(msg);
      break;
  }
 }

// ── Member list rendering ─────────────────────────────────────────────────
function renderMembers(members) {
  memberCount.textContent = `${members.length} watching`;
  memberList.innerHTML = '';
  members.forEach(m => {
    const el = document.createElement('div');
    el.className = 'member-item';
    const initial = (m.displayName ?? '?')[0].toUpperCase();
    const badgeClass = m.role === 'host' ? 'badge-host' : m.role === 'co-host' ? 'badge-cohost' : 'badge-guest';
    const roleLabel  = m.role === 'host' ? '👑 Host' : m.role === 'co-host' ? '⭐ Co-Host' : 'Guest';
    el.innerHTML = `
      <div class="member-avatar" aria-hidden="true">${initial}</div>
      <span class="member-name">${m.displayName ?? 'Guest'}</span>
      <span class="badge ${badgeClass}">${roleLabel}</span>
    `;
    memberList.appendChild(el);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FR-05: Queue UI
// ══════════════════════════════════════════════════════════════════════════

/**
 * Render the queue list from server data.
 */
function renderQueue(queue) {
  queueCount.textContent = `(${queue.length})`;
  queueList.innerHTML = '';

  if (queue.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'queue-empty-msg';
    emptyEl.textContent = 'No videos in queue yet. Nominate one above!';
    queueList.appendChild(emptyEl);
    return;
  }

  queue.forEach((entry, idx) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.queueId = entry.id;

    // Extract a friendly display name from the URL
    const displayUrl = extractVideoLabel(entry.url);

    let removeBtn = '';
    if (role === 'host' || role === 'co-host') {
      removeBtn = `<button class="queue-remove-btn" onclick="removeFromQueue(${entry.id})" aria-label="Remove from queue">✕</button>`;
    }

    el.innerHTML = `
      <span class="queue-rank">#${idx + 1}</span>
      <div class="queue-info">
        <span class="queue-url" title="${entry.url}">${displayUrl}</span>
        <span class="queue-meta">Added by ${entry.added_by === userId ? 'you' : entry.added_by?.slice(0, 8) + '…'}</span>
      </div>
      <div class="queue-actions">
        <button class="queue-vote-btn" onclick="upvoteQueue(${entry.id})" aria-label="Upvote">
          ▲ ${entry.upvotes}
        </button>
        ${removeBtn}
      </div>
    `;
    queueList.appendChild(el);
  });
}

/**
 * Extract a human-readable label from a video URL.
 */
function extractVideoLabel(url) {
  try {
    const u = new URL(url);
    // YouTube
    const v = u.searchParams.get('v');
    if (v) return `youtube.com/watch?v=${v}`;
    if (u.hostname === 'youtu.be') return `youtu.be/${u.pathname.slice(1)}`;
    // Fallback
    return u.hostname + u.pathname;
  } catch {
    return url.length > 40 ? url.slice(0, 40) + '…' : url;
  }
}

/**
 * Add a video to the queue (FR-05).
 */
function addToQueue() {
  const url = queueUrlInput.value.trim();
  if (!url) { toast('Enter a YouTube URL to nominate.', 'error'); return; }
  sendWs({ type: 'QUEUE_ADD', url });
  queueUrlInput.value = '';
  toast('Video added to queue!', 'success');
}

/**
 * Upvote a queue entry (FR-05).
 */
function upvoteQueue(queueId) {
  sendWs({ type: 'QUEUE_UPVOTE', queueId });
}

/**
 * Remove a queue entry — host only (FR-05).
 */
function removeFromQueue(queueId) {
  sendWs({ type: 'QUEUE_REMOVE', queueId });
}

// ══════════════════════════════════════════════════════════════════════════
// FR-06: Skip Vote UI
// ══════════════════════════════════════════════════════════════════════════

/**
 * Vote to skip the current video (FR-06).
 */
function voteSkip() {
  sendWs({ type: 'SKIP_VOTE' });
}

/**
 * Update the skip vote progress display.
 */
function updateSkipProgress(count, needed) {
  skipProgress.textContent = `${count} / ${needed} votes`;
}

// ══════════════════════════════════════════════════════════════════════════
// FR-10: Live Chat
// ══════════════════════════════════════════════════════════════════════════

/**
 * Send a chat message.
 */
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  sendWs({ type: 'CHAT_MSG', text });
  chatInput.value = '';
}

/**
 * Send an emoji reaction.
 */
function sendReaction(emoji) {
  sendWs({ type: 'CHAT_REACTION', emoji });
}

/**
 * Format a timestamp for chat display.
 */
function fmtTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Sanitize text for HTML display (prevent XSS).
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render a single chat message in the chat panel.
 */
function renderChatMessage(msg) {
  // Remove empty state
  if (chatEmpty) chatEmpty.remove();

  const el = document.createElement('div');

  if (msg.isSystem) {
    el.className = 'chat-msg chat-msg-system';
    el.textContent = msg.text;
  } else {
    el.className = 'chat-msg';
    const initial = (msg.displayName ?? '?')[0].toUpperCase();
    const isMe = msg.userId === userId;
    el.innerHTML = `
      <div class="chat-avatar" aria-hidden="true">${initial}</div>
      <div class="chat-body">
        <span class="chat-author" style="${isMe ? 'color: var(--success);' : ''}">${escapeHtml(msg.displayName ?? 'Guest')}</span>
        <span class="chat-time">${fmtTime(msg.timestamp)}</span>
        <div class="chat-text">${escapeHtml(msg.text)}</div>
      </div>
    `;
  }

  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Render an emoji reaction in the chat panel.
 */
function renderChatReaction(msg) {
  if (chatEmpty) chatEmpty.remove();

  const el = document.createElement('div');
  el.className = 'chat-msg';
  const initial = (msg.displayName ?? '?')[0].toUpperCase();
  el.innerHTML = `
    <div class="chat-avatar" aria-hidden="true">${initial}</div>
    <div class="chat-body">
      <span class="chat-author">${escapeHtml(msg.displayName ?? 'Guest')}</span>
      <span class="chat-time">${fmtTime(msg.timestamp)}</span>
      <div class="chat-reaction-bubble">${escapeHtml(msg.emoji)}</div>
    </div>
  `;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Render chat history for late joiners (FR-10 + FR-03).
 */
function renderChatHistory(messages) {
  if (!messages.length) return;
  if (chatEmpty) chatEmpty.remove();

  messages.forEach(msg => {
    if (msg.type === 'CHAT_REACTION') {
      renderChatReaction(msg);
    } else {
      renderChatMessage(msg);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FR-08: Display Name Change (mid-session)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Change display name mid-session.
 */
function changeName() {
  const newName = nameInput.value.trim();
  if (!newName) { toast('Enter a display name.', 'error'); return; }
  sendWs({ type: 'SET_NAME', displayName: newName });
  sessionStorage.setItem('wp_displayName', newName);
  toast(`Display name changed to "${newName}"`, 'success');
}

// ══════════════════════════════════════════════════════════════════════════
// Host control functions (FR-02 / FR-04)
// ══════════════════════════════════════════════════════════════════════════

function togglePlay() {
  syncPlayerSnapshot();
  if (localStatus === 'playing') {
    logSync(`[PLAY-BTN] Pausing video at ${getPlayerTime().toFixed(1)}s`);
    sendWs({ type: 'PAUSE', position: getPlayerTime() });
  } else {
    logSync(`[PLAY-BTN] Playing video from ${getPlayerTime().toFixed(1)}s`);
    sendWs({ type: 'PLAY', position: getPlayerTime() });
  }
}

// Seek bar: local visual update while dragging
function onSeekInput(value) {
  seekPending = true;
  const duration = getPlayerDuration();
  const s = duration ? (parseFloat(value) / 100) * duration : 0;
  timeCurrent.textContent = fmt(s);
}

// Seek bar: committed → broadcast SEEK
function onSeekCommit(value) {
  const duration = getPlayerDuration();
  if (!duration) {
    seekPending = false;
    toast('Video timing is not ready yet. Try again in a moment.', 'warn');
    return;
  }

  seekPending   = false;
  localPosition = (parseFloat(value) / 100) * duration;
  updateSeekBar();
  logSync(`[SEEK-COMMIT] Seeking to ${localPosition.toFixed(1)}s via seek bar`);
  sendWs({ type: 'SEEK', position: localPosition });
}

function commitKeyboardSeek(nextPosition) {
  const duration = getPlayerDuration();
  if (!duration) return false;

  seekPending = false;
  localPosition = Math.max(0, Math.min(nextPosition, duration));
  updateSeekBar();
  logSync(`[SEEK-KEYBOARD] Arrow key seek to ${localPosition.toFixed(1)}s`);
  sendWs({ type: 'SEEK', position: localPosition });
  return true;
}

function handlePlayerAreaKeydown(event) {
  if (!isHostController() || videoShell.classList.contains('hidden')) return;

  let nextPosition = null;
  let keyName = '';
  let handled = false;

  if (event.key === 'ArrowLeft') {
    nextPosition = getPlayerTime() - KEYBOARD_SEEK_STEP_SECONDS;
    keyName = 'ArrowLeft';
    handled = true;
  } else if (event.key === 'ArrowRight') {
    nextPosition = getPlayerTime() + KEYBOARD_SEEK_STEP_SECONDS;
    keyName = 'ArrowRight';
    handled = true;
  } else if (event.key === 'Home') {
    nextPosition = 0;
    keyName = 'Home';
    handled = true;
  } else if (event.key === 'End') {
    nextPosition = getPlayerDuration();
    keyName = 'End';
    handled = true;
  }

  if (!handled) return;

  event.preventDefault();
  event.stopPropagation();
  logSync(`[KEY-${keyName}] Current: ${getPlayerTime().toFixed(1)}s → Next: ${nextPosition.toFixed(1)}s`);
  commitKeyboardSeek(nextPosition);
}

// Global keyboard handler as fallback for arrow keys
document.addEventListener('keydown', (event) => {
  if (!isHostController() || videoShell?.classList.contains('hidden')) return;
  
  // Only handle if video player has focus or player area has focus
  const isFocused = document.activeElement === videoShell || 
                    document.activeElement === playerArea ||
                    document.activeElement === document.body;
  
  if (!isFocused && !videoShell?.contains(document.activeElement)) return;
  
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    // Dispatch to the normal handler
    const customEvent = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      bubbles: true,
    });
    playerArea?.dispatchEvent(customEvent);
  }
}, true);

// Load URL (host panel)
function loadVideo() {
  const url = urlInput.value.trim();
  if (!url) { toast('Enter a YouTube URL first.', 'error'); return; }
  sendWs({ type: 'LOAD', url });
  urlInput.value = '';
}

// Copy invite link
function copyInvite() {
  navigator.clipboard.writeText(inviteLink)
    .then(() => toast('Invite link copied!', 'success'))
    .catch(() => toast('Could not copy — please copy manually.', 'warn'));
}

// Leave room
function leaveRoom() {
  logSync(`[LEAVING-ROOM]`);
  if (ws) ws.close();
  if (poller) clearInterval(poller);
  if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
  if (syncVerificationTimer) clearInterval(syncVerificationTimer);
  if (ytPlayer?.destroy) ytPlayer.destroy();
  sessionStorage.clear();
  location.replace('/');
}

// ── Sync Verification (NEW) ────────────────────────────────────────────────
function startSyncVerification() {
  if (isHostController()) return; // Only guests verify
  
  if (syncVerificationTimer) clearInterval(syncVerificationTimer);
  
  syncVerificationTimer = setInterval(() => {
    if (videoShell.classList.contains('hidden') || !playerReady) return;
    
    // Verify we're at expected position
    const actualPos = getPlayerTime();
    const expectedPos = localPosition;
    const drift = Math.abs(actualPos - expectedPos);
    
    if (drift > ALLOWED_SYNC_DRIFT) {
      logSync(`[SYNC-VERIFY] DRIFT DETECTED: expected=${expectedPos.toFixed(1)}s, actual=${actualPos.toFixed(1)}s, diff=${drift.toFixed(1)}s`);
      // Broadcast our actual position so host can correct us if needed
      sendWs({ type: 'SYNC_CHECK', position: actualPos, expected: expectedPos, drift });
    } else {
      logSync(`[SYNC-VERIFY] OK - drift=${drift.toFixed(2)}s within tolerance`);
    }
  }, SYNC_VERIFY_INTERVAL);
  
  logSync(`[SYNC-VERIFY] Started verification interval (${SYNC_VERIFY_INTERVAL}ms)`);
}

function handleSyncCheck(msg) {
  // Only host handles sync check from guests
  if (!isHostController()) return;
  
  const guestPos = msg.position;
  const guestExpected = msg.expected;
  const guestDrift = msg.drift;
  const hostExpected = localPosition;
  const hostDrift = Math.abs(hostExpected - guestPos);
  
  logSync(`[SYNC-CHECK-RCV] From guest: pos=${guestPos.toFixed(1)}s, expected=${guestExpected.toFixed(1)}s, host-view-of-guest-pos=${hostExpected.toFixed(1)}s`);
  
  // If guest has significant drift from host's view, send correction
  if (hostDrift > ALLOWED_SYNC_DRIFT) {
    logSync(`[SYNC-CORRECT] Correcting guest drift=${hostDrift.toFixed(1)}s, sending SEEK to ${hostExpected.toFixed(1)}s`);
    // Send direct correction seek
    sendWs({ type: 'SEEK', position: hostExpected });
  }
}

// ── Enter url with Enter key ──────────────────────────────────────────────
urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') loadVideo(); });
queueUrlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addToQueue(); });
chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') changeName(); });
playerArea?.addEventListener('keydown', handlePlayerAreaKeydown);

// ── Bootstrap ─────────────────────────────────────────────────────────────
(function init() {
  logSync(`[INIT] Role=${role}, UserId=${userId}, RoomId=${roomId}`);
  applyRoleUI();
  showInviteLink();
  if (role === 'guest') {
    emptyHint.textContent = 'Waiting for the host to load a video…';
  }
  
  // FR-08: Pre-fill display name input
  if (nameInput) nameInput.value = displayName;
  
  // Ensure player area is focusable for keyboard controls
  playerArea?.setAttribute('tabindex', '0');
  playerArea?.addEventListener('focus', () => {
    logSync(`[FOCUS] Player area focused`);
  });
  
  connect();
})();
