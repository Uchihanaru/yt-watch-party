const socket = io({ reconnection: true });

// =========================================================================
// 0. OS & CAPABILITY DETECTION
// =========================================================================
const userAgent = navigator.userAgent || navigator.vendor || window.opera;
const isIPhone = /iPhone|iPod/.test(userAgent);
if (!isIPhone) { document.body.classList.add('fs-overlay-supported'); }

let currentRoom = '';
let localUsername = '';
let isRemoteAction = false; 
let player = null; 
let hlsInstance = null; 
let isHost = false;

let deviceId = localStorage.getItem('synctube_device');
if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('synctube_device', deviceId);
}

const elements = {
    modal: document.getElementById('welcomeModal'),
    modalDesc: document.getElementById('modalDesc'),
    modalUser: document.getElementById('modalUsername'),
    modalRoom: document.getElementById('modalRoom'),
    modalBtn: document.getElementById('modalActionBtn'),
    modalStatus: document.getElementById('modalStatus'),
    knockContainer: document.getElementById('knockContainer'),
    navRoom: document.getElementById('navRoomDisplay'),
    localUser: document.getElementById('localUsernameDisplay'),
    roomStatus: document.getElementById('roomStatusDisplay'),
    inviteBtn: document.getElementById('inviteBtn'),
    inviteText: document.getElementById('inviteText'),
    videoInput: document.getElementById('videoInput'),
    loadBtn: document.getElementById('loadBtn'),
    chatInput: document.getElementById('chatInput'),
    sendBtn: document.getElementById('sendBtn'),
    chatMessages: document.getElementById('chatMessages'),
    chatColumn: document.getElementById('chatColumn'),
    emojiBtn: document.getElementById('emojiBtn'),
    emojiPicker: document.getElementById('emojiPicker'),
    htmlPlayer: document.getElementById('htmlPlayer'),
    ytPlayerContainer: document.getElementById('player'),
    qualitySelector: document.getElementById('qualitySelector'),
    customFsBtn: document.getElementById('customFsBtn'),
    mainLayout: document.getElementById('mainLayout'),
    userCountDisplay: document.getElementById('userCountDisplay'),
    fsUserCountDisplay: document.getElementById('fsUserCountDisplay'),
    fsRoomDisplay: document.getElementById('fsRoomDisplay'), 
    touchBtn: document.getElementById('touchBtn'),
    videoWrapper: document.getElementById('videoWrapper'),
    exitFsBtn: document.getElementById('exitFsBtn'),
    reactionContainer: document.getElementById('reactionContainer'),
    reactionBtns: document.querySelectorAll('.reaction-btn'),
    autoplayOverlay: document.getElementById('autoplayOverlay'),
    ghostIframe: document.getElementById('ghostIframe')
};

// =========================================================================
// 1. MODAL & ACCESS FLOW 
// =========================================================================
const savedName = localStorage.getItem('synctube_username');
if (savedName) elements.modalUser.value = savedName;

try {
    const urlParams = new URLSearchParams(window.location.search);
    const invitedRoom = urlParams.get('room');
    if (invitedRoom) {
        elements.modalRoom.value = invitedRoom;
        elements.modalDesc.innerText = "You've been invited! Enter your alias to knock.";
        elements.modalBtn.innerText = "Knock to Enter";
    }
} catch (e) { console.error(e); }

elements.modalBtn.addEventListener('click', () => {
    const userVal = elements.modalUser.value.trim();
    const roomVal = elements.modalRoom.value.trim();
    if (!userVal) return alert("Username is mandatory.");

    localUsername = userVal;
    localStorage.setItem('synctube_username', localUsername); 
    elements.localUser.innerText = `${localUsername} (You)`;
    
    if (roomVal) {
        elements.modalStatus.style.display = 'block';
        elements.modalStatus.innerText = 'Connecting...';
        elements.modalBtn.disabled = true;
        socket.emit('requestJoin', { roomId: roomVal, username: localUsername, deviceId: deviceId });
    } else {
        socket.emit('createRoom', { username: localUsername, deviceId: deviceId }, (response) => {
            if (response.success) {
                isHost = true;
                currentRoom = response.roomId;
                initRoomUI();
            }
        });
    }
});

socket.on('joinError', (msg) => {
    elements.modalStatus.innerText = msg;
    elements.modalBtn.disabled = false;
    setTimeout(() => { window.location.search = ''; }, 3000);
});

socket.on('waitingForHost', (msg) => { elements.modalStatus.innerText = msg; });

socket.on('joinSuccess', (data) => {
    currentRoom = data.roomId;
    localUsername = localStorage.getItem('synctube_username') || 'Anonymous';
    elements.localUser.innerText = `${localUsername} (You)`;
    initRoomUI();
    
    isRemoteAction = true;
    if (data.videoId.startsWith('embed:')) {
        mountGhostIframe(data.videoId.substring(6));
    } else if (data.videoId.startsWith('hls:')) {
        mountDirectVideo(data.videoId.substring(4), data.time, data.state, true);
    } else if (data.videoId.startsWith('http')) {
        mountDirectVideo(data.videoId, data.time, data.state, false);
    } else {
        mountYouTubeVideo(data.videoId, data.time, data.state);
    }
    setTimeout(() => isRemoteAction = false, 1500);
});

function initRoomUI() {
    const shortHash = currentRoom.substring(0, 6).toUpperCase();
    elements.navRoom.innerText = `Room: ${shortHash}`;
    if (elements.fsRoomDisplay) elements.fsRoomDisplay.innerText = shortHash;
    elements.roomStatus.innerText = `Encrypted Connection Active`;
    elements.modal.classList.add('hidden');
    window.history.replaceState({}, '', `?room=${currentRoom}`);
}

// =========================================================================
// 2. THE HOST NOTIFICATION ENGINE
// =========================================================================
socket.on('guestKnocking', (data) => {
    if (!isHost) return;
    const toast = document.createElement('div');
    toast.className = 'knock-toast';
    toast.innerHTML = `
        <div style="font-size: 14px;"><strong>${DOMPurify.sanitize(data.username)}</strong> wants to join.</div>
        <div class="knock-actions">
            <button class="knock-btn btn-accept" data-id="${data.socketId}">Allow</button>
            <button class="knock-btn btn-deny" data-id="${data.socketId}">Deny</button>
        </div>
    `;
    elements.knockContainer.appendChild(toast);
    toast.querySelector('.btn-accept').addEventListener('click', () => {
        socket.emit('admitGuest', { roomId: currentRoom, guestSocketId: data.socketId, guestDeviceId: data.guestDeviceId, approved: true });
        toast.remove();
    });
    toast.querySelector('.btn-deny').addEventListener('click', () => {
        socket.emit('admitGuest', { roomId: currentRoom, guestSocketId: data.socketId, guestDeviceId: data.guestDeviceId, approved: false });
        toast.remove();
    });
});

socket.on('hostTransferred', () => {
    isHost = true;
    elements.roomStatus.innerText = `You are now the Host`;
});

// =========================================================================
// 3. DEMOCRATIC PLAYBACK ENGINE
// =========================================================================
function broadcastAction(action, time) {
    if (isRemoteAction) return;
    socket.emit('videoAction', { roomId: currentRoom, action, time });
}

elements.htmlPlayer.addEventListener('play', () => broadcastAction('play', elements.htmlPlayer.currentTime));
elements.htmlPlayer.addEventListener('pause', () => broadcastAction('pause', elements.htmlPlayer.currentTime));
elements.htmlPlayer.addEventListener('seeked', () => broadcastAction(elements.htmlPlayer.paused ? 'pause' : 'play', elements.htmlPlayer.currentTime));

window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '', 
        playerVars: { 'playsinline': 1, 'rel': 0, 'modestbranding': 1, 'fs': 1 },
        events: { 
            'onStateChange': (event) => {
                if (isRemoteAction || !player) return;
                const time = player.getCurrentTime();
                if (event.data === YT.PlayerState.PLAYING) broadcastAction('play', time);
                else if (event.data === YT.PlayerState.PAUSED) broadcastAction('pause', time);
            }
        }
    });
};

socket.on('syncAction', (data) => {
    isRemoteAction = true;
    const isDirect = !elements.htmlPlayer.classList.contains('hidden');
    const { action, time } = data;

    if (isDirect) {
        if (Math.abs(elements.htmlPlayer.currentTime - time) > 1) elements.htmlPlayer.currentTime = time;
        if (action === 'play') safePlay(elements.htmlPlayer);
        else elements.htmlPlayer.pause();
    } else if (player && typeof player.seekTo === 'function') {
        if (Math.abs(player.getCurrentTime() - time) > 1) player.seekTo(time, true);
        if (action === 'play') player.playVideo();
        else player.pauseVideo();
    }
    setTimeout(() => isRemoteAction = false, 500);
});

// =========================================================================
// 3.5. TWO-PHASE COMMIT BUFFER-READY PROTOCOL
// =========================================================================
socket.on('prepareToPlay', (data) => {
    isRemoteAction = true;
    const isDirect = !elements.htmlPlayer.classList.contains('hidden');
    
    if (isDirect) {
        elements.htmlPlayer.pause();
        if (Math.abs(elements.htmlPlayer.currentTime - data.time) > 1) elements.htmlPlayer.currentTime = data.time;
        
        const checkBuffer = setInterval(() => {
            if (elements.htmlPlayer.readyState >= 3) {
                clearInterval(checkBuffer);
                socket.emit('bufferReady', currentRoom);
            }
        }, 100);
    } else if (player && typeof player.pauseVideo === 'function') {
        player.pauseVideo();
        if (Math.abs(player.getCurrentTime() - data.time) > 1) player.seekTo(data.time, true);
        
        const checkBuffer = setInterval(() => {
            if (player.getPlayerState() !== YT.PlayerState.BUFFERING) {
                clearInterval(checkBuffer);
                socket.emit('bufferReady', currentRoom);
            }
        }, 100);
    }
});

socket.on('executePlay', (data) => {
    isRemoteAction = true;
    const isDirect = !elements.htmlPlayer.classList.contains('hidden');
    
    // Future execution scheduled by server (Anti-Jitter)
    // For simplicity without NTP sync, execute immediately since BufferReady guarantees no starvation
    if (isDirect) safePlay(elements.htmlPlayer);
    else if (player && typeof player.playVideo === 'function') player.playVideo();
    
    setTimeout(() => isRemoteAction = false, 500);
});

// =========================================================================
// 4. THE SECURE HOST ANCHOR ENGINE (BUFFERING TOLERANCE)
// =========================================================================
setInterval(() => {
    if (!currentRoom || isRemoteAction) return;
    const isDirect = !elements.htmlPlayer.classList.contains('hidden');
    let myTime = isDirect ? elements.htmlPlayer.currentTime : (player && typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0);
    let myState = isDirect ? (elements.htmlPlayer.paused ? 'paused' : 'playing') : (player && typeof player.getPlayerState === 'function' && player.getPlayerState() === 1 ? 'playing' : 'paused');
    if (isHost) socket.emit('hostHeartbeat', { roomId: currentRoom, time: myTime, state: myState });
}, 3000);

socket.on('syncCorrection', (serverState) => {
    if (isHost || isRemoteAction) return; 
    const isDirect = !elements.htmlPlayer.classList.contains('hidden');
    let myTime = isDirect ? elements.htmlPlayer.currentTime : (player && typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0);
    
    // Paranoia Agent Fix: Factor in one-way network latency (~100ms) to prevent ghost lagging
    const estimatedLatency = 0.100;
    const trueHostTime = serverState.state === 'playing' ? (serverState.time + estimatedLatency) : serverState.time;
    let drift = trueHostTime - myTime;

    if (Math.abs(drift) > 2.5) {
        isRemoteAction = true;
        if (isDirect) elements.htmlPlayer.currentTime = trueHostTime;
        else if (player && typeof player.seekTo === 'function') player.seekTo(trueHostTime, true);
        setTimeout(() => isRemoteAction = false, 800);
    } else if (Math.abs(drift) > 0.5 && isDirect && serverState.state === 'playing') {
        elements.htmlPlayer.playbackRate = drift > 0 ? 1.05 : 0.95;
    } else if (isDirect && elements.htmlPlayer.playbackRate !== 1.0) {
        elements.htmlPlayer.playbackRate = 1.0;
    }
});

// =========================================================================
// 5. TRIPLE VIDEO ROUTING & MEDIA TELEMETRY
// =========================================================================
socket.on('newVideo', (videoId) => {
    isRemoteAction = true;
    if (videoId.startsWith('embed:')) {
        mountGhostIframe(videoId.substring(6));
    } else if (videoId.startsWith('hls:')) {
        mountDirectVideo(videoId.substring(4), 0, 'playing', true);
    } else if (videoId.startsWith('http')) {
        mountDirectVideo(videoId, 0, 'playing', false);
    } else {
        mountYouTubeVideo(videoId);
    }
    setTimeout(() => isRemoteAction = false, 1000);
});

function safePlay(videoElement) {
    const playPromise = videoElement.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.warn("Mobile OS Blocked Autoplay.", error);
            elements.videoWrapper.classList.add('autoplay-blocked');
        });
    }
}

if (elements.autoplayOverlay) {
    elements.autoplayOverlay.addEventListener('click', () => {
        elements.videoWrapper.classList.remove('autoplay-blocked');
        elements.htmlPlayer.play();
        if (player && typeof player.playVideo === 'function') player.playVideo();
    });
}

function mountDirectVideo(url, time = 0, state = 'playing', forceHls = false) {
    elements.videoWrapper.classList.add('video-active'); 
    
    if (player && typeof player.pauseVideo === 'function') player.pauseVideo();
    if (elements.ghostIframe) { elements.ghostIframe.src = ''; elements.ghostIframe.classList.add('hidden'); }
    
    elements.ytPlayerContainer.classList.add('hidden');
    elements.htmlPlayer.classList.remove('hidden');
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    const triggerPlayback = () => {
        elements.htmlPlayer.currentTime = time;
        if (state === 'paused') elements.htmlPlayer.pause();
        else safePlay(elements.htmlPlayer);
    };

    if (Hls.isSupported() && (forceHls || url.includes('.m3u8'))) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(elements.htmlPlayer);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            elements.qualitySelector.classList.remove('hidden');
            elements.qualitySelector.innerHTML = '<option value="-1">Auto Quality</option>';
            data.levels.forEach((level, index) => {
                const opt = document.createElement('option');
                opt.value = index;
                opt.textContent = `${level.height}p`;
                elements.qualitySelector.appendChild(opt);
            });
            triggerPlayback(); 
        });
    } else {
        elements.qualitySelector.classList.add('hidden');
        elements.htmlPlayer.src = url;
        elements.htmlPlayer.load(); 
        
        if (elements.htmlPlayer.readyState >= 1) { 
            triggerPlayback();
        } else {
            elements.htmlPlayer.addEventListener('loadedmetadata', triggerPlayback, { once: true });
        }
    }
}

function mountYouTubeVideo(videoId, time = 0, state = 'playing') {
    elements.videoWrapper.classList.add('video-active');
    
    elements.htmlPlayer.pause();
    elements.htmlPlayer.src = '';
    if (elements.ghostIframe) { elements.ghostIframe.src = ''; elements.ghostIframe.classList.add('hidden'); }
    
    elements.htmlPlayer.classList.add('hidden');
    elements.qualitySelector.classList.add('hidden');
    elements.ytPlayerContainer.classList.remove('hidden');
    
    const checkPlayerReady = setInterval(() => {
        if (player && typeof player.loadVideoById === 'function') {
            clearInterval(checkPlayerReady);
            player.loadVideoById({ videoId: videoId, startSeconds: time });
            if (state === 'paused') setTimeout(() => player.pauseVideo(), 500);
        }
    }, 500);
}

function mountGhostIframe(url) {
    elements.videoWrapper.classList.add('video-active');
    
    if (player && typeof player.pauseVideo === 'function') player.pauseVideo();
    elements.htmlPlayer.pause();
    elements.htmlPlayer.src = '';
    
    elements.ytPlayerContainer.classList.add('hidden');
    elements.htmlPlayer.classList.add('hidden');
    elements.qualitySelector.classList.add('hidden');
    
    if (elements.ghostIframe) {
        elements.ghostIframe.classList.remove('hidden');
        elements.ghostIframe.src = url;
    }
}

// =========================================================================
// MEDIA ERROR TELEMETRY (WITH GHOST-FIRE DEFENSE)
// =========================================================================
elements.htmlPlayer.addEventListener('error', () => {
    // Fail silently in the background if intentionally cleared or hidden
    const currentSrc = elements.htmlPlayer.getAttribute('src');
    if (!currentSrc || currentSrc === '' || elements.htmlPlayer.classList.contains('hidden')) {
        return; 
    }

    const err = elements.htmlPlayer.error;
    if (err) {
        let msg = "Unknown Error";
        if (err.code === 1) msg = "Download Aborted";
        if (err.code === 2) msg = "Network Error (CORS Blocked by Server)";
        if (err.code === 3) msg = "Media Decode Error";
        if (err.code === 4) msg = "Format Not Supported (Masked URL or HTML wrapper)";
        
        console.error("Video Error:", msg);
        alert(`Direct Engine Failed: ${msg}.\n\nTry forcing the engine:\n1. Type "hls:" before the link for masked streams.\n2. Type "embed:" for HTML websites.`);
    }
});

const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function parseVideoInput(url) {
    const trimmed = url.trim();
    if (trimmed.toLowerCase().startsWith('embed:')) return 'embed:' + trimmed.substring(6).trim();
    if (trimmed.toLowerCase().startsWith('hls:')) return 'hls:' + trimmed.substring(4).trim();
    
    const ytRegExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = trimmed.match(ytRegExp);
    if (match && match[2].length === 11) return match[2]; 
    if (trimmed.length === 11) return trimmed; 
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed; 
    return null;
}

elements.loadBtn.addEventListener('click', () => {
    const videoId = parseVideoInput(elements.videoInput.value);
    if (videoId) {
        socket.emit('loadVideo', { roomId: currentRoom, videoId });
        elements.videoInput.value = ''; 
    } else { alert('Invalid link format.'); }
});

elements.videoInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') elements.loadBtn.click(); });

elements.inviteBtn.addEventListener('click', async () => {
    if (!currentRoom) return;
    const inviteLink = `${window.location.origin}${window.location.pathname}?room=${currentRoom}`;
    try {
        await navigator.clipboard.writeText(inviteLink);
        elements.inviteText.innerText = 'Copied!';
        setTimeout(() => elements.inviteText.innerText = 'Copy Invite', 2000);
    } catch (err) { prompt("Copy this link:", inviteLink); }
});

socket.on('roomCountUpdate', (count) => {
    elements.userCountDisplay.innerText = count;
    if (elements.fsUserCountDisplay) elements.fsUserCountDisplay.innerText = count;
});

// =========================================================================
// 6. FLOATING CINEMATIC REACTION ENGINE 
// =========================================================================
function spawnFloatingReaction(emoji) {
    if (!elements.reactionContainer) return;
    const el = document.createElement('div');
    el.classList.add('floating-emoji');
    el.innerText = emoji;
    const startX = Math.random() * 80; 
    el.style.left = `${startX}%`;
    elements.reactionContainer.appendChild(el);
    
    const duration = 2000 + Math.random() * 1500; 
    const horizontalDrift = (Math.random() - 0.5) * 80; 
    const floatHeight = 150 + Math.random() * 200; 
    
    const animation = el.animate([
        { transform: `translate(0, 0) scale(0.5)`, opacity: 0 },
        { transform: `translate(${horizontalDrift / 2}px, -${floatHeight / 2}px) scale(1.5)`, opacity: 1, offset: 0.2 },
        { transform: `translate(${horizontalDrift}px, -${floatHeight}px) scale(1)`, opacity: 0 }
    ], { duration: duration, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' });
    animation.onfinish = () => el.remove();
}

if (elements.reactionBtns) {
    elements.reactionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const emoji = btn.innerText;
            spawnFloatingReaction(emoji); 
            if (currentRoom) socket.emit('sendReaction', { roomId: currentRoom, emoji: emoji });
        });
    });
}
socket.on('receiveReaction', (emoji) => { spawnFloatingReaction(emoji); });

// =========================================================================
// 7. CHAT & HAPTICS (WITH NATIVE TOUCH & EMOJI PARSER)
// =========================================================================
function sendMessage() {
    const msg = elements.chatInput.value.trim();
    if (msg && currentRoom) {
        socket.emit('chatMessage', { roomId: currentRoom, message: msg });
        elements.chatInput.value = '';
    }
}

elements.sendBtn.addEventListener('click', sendMessage);
elements.chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
elements.sendBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendMessage(); }, { passive: false });
elements.sendBtn.addEventListener('mousedown', (e) => e.preventDefault());

function sendDigitalTouch() {
    spawnFloatingReaction('💖');
    if (currentRoom) socket.emit('sendReaction', { roomId: currentRoom, emoji: '💖' });
    if (currentRoom) socket.emit('digitalTouch', currentRoom);
}

elements.touchBtn.addEventListener('click', sendDigitalTouch);
elements.touchBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendDigitalTouch(); }, { passive: false });
elements.touchBtn.addEventListener('mousedown', (e) => e.preventDefault());

socket.on('newMessage', (data) => {
    const msgElement = document.createElement('div');
    msgElement.classList.add('chat-message');
    const cleanText = DOMPurify.sanitize(data.message);
    
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    const extractedEmojis = cleanText.match(emojiRegex);
    if (extractedEmojis) {
        extractedEmojis.slice(0, 4).forEach((emoji, index) => {
            setTimeout(() => spawnFloatingReaction(emoji), index * 150);
        });
    }

    let hash = 0;
    for (let i = 0; i < data.username.length; i++) { hash = data.username.charCodeAt(i) + ((hash << 5) - hash); }
    const color = `hsl(${Math.abs(hash) % 360}, 75%, 45%)`;

    msgElement.innerHTML = `
        <div class="chat-avatar" style="background-color: ${color}">${data.username.charAt(0).toUpperCase()}</div>
        <div class="chat-content">
            <span class="chat-author">${data.username}</span>
            <span class="chat-text">${cleanText}</span>
        </div>
    `;
    elements.chatMessages.appendChild(msgElement);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    if (document.body.classList.contains('is-fullscreen')) {
        elements.chatColumn.classList.add('chat-peek');
        clearTimeout(window.chatFadeTimer);
        window.chatFadeTimer = setTimeout(() => { elements.chatColumn.classList.remove('chat-peek'); }, 4000); 
    }
});

socket.on('receiveTouch', () => {
    elements.videoWrapper.classList.remove('glow-active');
    void elements.videoWrapper.offsetWidth; 
    elements.videoWrapper.classList.add('glow-active');
    if (navigator.vibrate) navigator.vibrate([50, 100, 50]);
    setTimeout(() => { elements.videoWrapper.classList.remove('glow-active'); }, 2500);
});

elements.emojiBtn.addEventListener('click', () => elements.emojiPicker.classList.toggle('hidden'));
elements.emojiPicker.addEventListener('emoji-click', event => {
    elements.chatInput.value += event.detail.unicode;
    elements.emojiPicker.classList.add('hidden'); 
    elements.chatInput.focus();
});

// =========================================================================
// 8. CROSS-BROWSER FULLSCREEN ENGINE (WITH REFLOW FIX)
// =========================================================================
elements.customFsBtn.addEventListener('click', () => {
    const doc = document.documentElement; 
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    
    if (!isFs) {
        if (doc.requestFullscreen) doc.requestFullscreen().catch(err => console.warn(err));
        else if (doc.webkitRequestFullscreen) doc.webkitRequestFullscreen(); 
        else if (elements.htmlPlayer.webkitEnterFullscreen) elements.htmlPlayer.webkitEnterFullscreen();
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); 
    }
});

if (elements.exitFsBtn) {
    elements.exitFsBtn.addEventListener('click', () => {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); 
    });
}

function handleFsChange() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        document.body.classList.add('is-fullscreen');
    } else { 
        document.body.classList.remove('is-fullscreen'); 
        setTimeout(() => {
            if (window.innerWidth > 1024) { elements.mainLayout.style.height = ''; }
            window.dispatchEvent(new Event('resize')); 
        }, 100);
    }
}
document.addEventListener('fullscreenchange', handleFsChange);
document.addEventListener('webkitfullscreenchange', handleFsChange);
elements.qualitySelector.addEventListener('change', (e) => {
    if (hlsInstance) hlsInstance.currentLevel = parseInt(e.target.value);
});

// =========================================================================
// 9. VIEWPORT, GYRO-LOCK & KEYBOARD ENGINES (NATIVE APP FEEL)
// =========================================================================

// --- ESCAPE HATCH 1: THE PHANTOM SHIELD ---
const phantomShield = document.createElement('div');
phantomShield.className = 'phantom-shield';
elements.videoWrapper.appendChild(phantomShield);

phantomShield.addEventListener('click', () => elements.chatInput.blur());
phantomShield.addEventListener('touchstart', (e) => {
    e.preventDefault();
    elements.chatInput.blur();
}, { passive: false });

// --- ESCAPE HATCH 2: SCROLL-TO-DISMISS ---
let chatTouchStartY = 0;
elements.chatMessages.addEventListener('touchstart', (e) => {
    chatTouchStartY = e.touches[0].clientY;
}, { passive: true });

elements.chatMessages.addEventListener('touchmove', (e) => {
    if (!document.body.classList.contains('keyboard-active')) return;
    const currentY = e.touches[0].clientY;
    if (currentY > chatTouchStartY + 50) { 
        elements.chatInput.blur();
    }
}, { passive: true });

// --- ESCAPE HATCH 3: GYRO-LOCKED VIEWPORT SNIFFER ---
let isRotating = false;
window.addEventListener('orientationchange', () => {
    isRotating = true;
    setTimeout(() => { isRotating = false; }, 800);
});

elements.chatInput.addEventListener('focus', () => {
    if (window.innerWidth <= 1024) {
        document.body.classList.add('keyboard-active');
        setTimeout(() => elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight, 150);
    }
});

elements.chatInput.addEventListener('blur', () => {
    document.body.classList.remove('keyboard-active');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
});

if (window.visualViewport) {
    let resizeTimeout;
    let lastViewportHeight = window.visualViewport.height;

    window.visualViewport.addEventListener('resize', () => {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            elements.mainLayout.style.height = '100dvh'; return;
        }
        
        const currentHeight = window.visualViewport.height;
        const heightDelta = currentHeight - lastViewportHeight;
        lastViewportHeight = currentHeight;

        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (window.innerWidth <= 1024) {
                if (document.body.classList.contains('keyboard-active') && !isRotating && heightDelta > 150) {
                    elements.chatInput.blur();
                }

                const navOffset = document.body.classList.contains('keyboard-active') ? 0 : 64;
                elements.mainLayout.style.height = `${window.visualViewport.height - navOffset}px`;
                elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
            } else { 
                elements.mainLayout.style.height = ''; 
            }
        }, 100);
    });
    
    if (window.innerWidth <= 1024) {
        elements.mainLayout.style.height = `${window.visualViewport.height - 64}px`;
    }
}

document.addEventListener('visibilitychange', async () => {
    const isDirectStream = !elements.htmlPlayer.classList.contains('hidden');
    if (document.hidden && isDirectStream && !elements.htmlPlayer.paused) {
        if (document.pictureInPictureEnabled && !elements.htmlPlayer.disablePictureInPicture) {
            try { await elements.htmlPlayer.requestPictureInPicture(); } catch (err) { }
        }
    } else if (!document.hidden && document.pictureInPictureElement) {
        try { await document.exitPictureInPicture(); } catch (err) { }
    }
});