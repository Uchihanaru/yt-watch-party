const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const roomStates = new Map(); 

io.on('connection', (socket) => {
    console.log(`Connection established: ${socket.id}`);

    // 1. SECURE ROOM CREATION
    socket.on('createRoom', (data, callback) => {
        const roomId = crypto.randomBytes(8).toString('hex'); 
        socket.join(roomId);
        socket.currentRoom = roomId;
        socket.deviceId = data.deviceId; 
        socket.username = data.username;

        roomStates.set(roomId, {
            hostDevice: data.deviceId,
            hostSocket: socket.id,
            approvedDevices: new Set([data.deviceId]), 
            activeSockets: new Set([socket.id]), 
            videoId: 'M7lc1UVf-VE',
            playbackState: 'paused',
            videoTime: 0,
            lastUpdatedAt: Date.now(),
            gcTimer: null,
            readyClients: new Set()
        });

        callback({ success: true, roomId: roomId });
        io.to(roomId).emit('roomCountUpdate', 1);
    });

    // 2. THE KNOCK & ADMIT PROTOCOL (AUTO-RECONNECT)
    socket.on('requestJoin', (data) => {
        const { roomId, username, deviceId } = data;
        const room = roomStates.get(roomId);

        if (!room) return socket.emit('joinError', 'Room does not exist or has expired.');

        socket.deviceId = deviceId;
        socket.username = username;

        if (room.approvedDevices.has(deviceId)) {
            if (room.gcTimer) { clearTimeout(room.gcTimer); room.gcTimer = null; }
            socket.join(roomId);
            socket.currentRoom = roomId;
            room.activeSockets.add(socket.id);

            if (room.hostDevice === deviceId) {
                room.hostSocket = socket.id;
                socket.emit('hostTransferred'); 
            }

            const calculatedTime = calculateCurrentVideoTime(room);
            socket.emit('joinSuccess', {
                roomId: roomId, videoId: room.videoId,
                time: calculatedTime, state: room.playbackState
            });
            
            io.to(roomId).emit('roomCountUpdate', room.activeSockets.size);
            return;
        }

        io.to(room.hostSocket).emit('guestKnocking', { socketId: socket.id, guestDeviceId: deviceId, username: username });
        socket.emit('waitingForHost', 'Waiting for the host to let you in...');
    });

    socket.on('admitGuest', (data) => {
        const { roomId, guestSocketId, guestDeviceId, approved } = data;
        const room = roomStates.get(roomId);

        if (!room || room.hostSocket !== socket.id) return;

        if (approved) {
            room.approvedDevices.add(guestDeviceId);
            const guestSocket = io.sockets.sockets.get(guestSocketId);
            
            if (guestSocket) {
                guestSocket.join(roomId);
                guestSocket.currentRoom = roomId;
                room.activeSockets.add(guestSocket.id);
                
                const calculatedTime = calculateCurrentVideoTime(room);
                guestSocket.emit('joinSuccess', { roomId: roomId, videoId: room.videoId, time: calculatedTime, state: room.playbackState });
                io.to(roomId).emit('roomCountUpdate', room.activeSockets.size);
            }
        } else {
            io.to(guestSocketId).emit('joinError', 'The host declined your request.');
        }
    });

    // 3. DEMOCRATIC PLAYBACK & MEDIA ACTIONS (TWO-PHASE COMMIT)
    socket.on('videoAction', (data) => {
        const { roomId, action, time } = data; 
        const room = roomStates.get(roomId);
        if (!room || !room.approvedDevices.has(socket.deviceId)) return;

        room.videoTime = time;
        room.lastUpdatedAt = Date.now();

        if (action === 'play') {
            room.playbackState = 'buffering';
            room.readyClients = new Set();
            io.to(roomId).emit('prepareToPlay', { time: time });
        } else {
            room.playbackState = 'paused';
            socket.to(roomId).emit('syncAction', { action, time });
        }
    });

    // 3.5. BUFFER READY HANDSHAKE (ANTI-STARVATION)
    socket.on('bufferReady', (roomId) => {
        const room = roomStates.get(roomId);
        if (!room || room.playbackState !== 'buffering') return;
        
        room.readyClients.add(socket.id);
        
        let allReady = true;
        for (let sid of room.activeSockets) {
            if (!room.readyClients.has(sid)) {
                allReady = false;
                break;
            }
        }
        
        if (allReady) {
            room.playbackState = 'playing';
            room.lastUpdatedAt = Date.now();
            const executionTime = Date.now() + 300; // 300ms network propagation buffer
            io.to(roomId).emit('executePlay', { time: room.videoTime, ntpStart: executionTime });
        }
    });

    socket.on('loadVideo', (data) => {
        const { roomId, videoId } = data;
        const room = roomStates.get(roomId);
        if (!room || !room.approvedDevices.has(socket.deviceId)) return;

        room.videoId = videoId;
        room.videoTime = 0;
        room.playbackState = 'playing';
        room.lastUpdatedAt = Date.now();
        io.to(roomId).emit('newVideo', videoId);
    });

    // 4. SECURE HOST ANCHOR (BUFFERING TOLERANCE & LATENCY OFFSET)
    socket.on('hostHeartbeat', (data) => {
        const { roomId, time, state, clientPingOffset = 0 } = data;
        const room = roomStates.get(roomId);
        if (!room || room.hostDevice !== socket.deviceId) return;

        // Prevent heartbeat from overriding a buffering state
        if (room.playbackState === 'buffering') return;

        room.videoTime = time;
        room.playbackState = state;
        room.lastUpdatedAt = Date.now();
        
        // Pass server Date.now() so clients can calculate one-way latency
        socket.to(roomId).emit('syncCorrection', { 
            time: time, 
            state: state, 
            serverTime: Date.now() 
        });
    });

    // 5. CHAT & HAPTICS & REACTIONS
    socket.on('chatMessage', (data) => {
        const room = roomStates.get(data.roomId);
        if (!room || !room.approvedDevices.has(socket.deviceId)) return;
        io.to(data.roomId).emit('newMessage', { username: socket.username, message: data.message });
    });

    socket.on('digitalTouch', (roomId) => {
        const room = roomStates.get(roomId);
        if (!room || !room.approvedDevices.has(socket.deviceId)) return;
        socket.to(roomId).emit('receiveTouch');
    });

    socket.on('sendReaction', (data) => {
        const room = roomStates.get(data.roomId);
        if (!room || !room.approvedDevices.has(socket.deviceId)) return;
        socket.to(data.roomId).emit('receiveReaction', data.emoji);
    });

    // 6. GHOST ROOM DISCONNECT ENGINE
    socket.on('disconnect', () => {
        if (socket.currentRoom) {
            const room = roomStates.get(socket.currentRoom);
            if (room) {
                room.activeSockets.delete(socket.id);
                io.to(socket.currentRoom).emit('roomCountUpdate', room.activeSockets.size);

                if (room.activeSockets.size === 0) {
                    room.gcTimer = setTimeout(() => { roomStates.delete(socket.currentRoom); }, 120000); 
                } else if (room.hostSocket === socket.id) {
                    const nextHostSocketId = room.activeSockets.values().next().value;
                    const nextHostSocket = io.sockets.sockets.get(nextHostSocketId);
                    if (nextHostSocket) {
                        room.hostSocket = nextHostSocket.id;
                        room.hostDevice = nextHostSocket.deviceId;
                        io.to(nextHostSocket.id).emit('hostTransferred');
                    }
                }
            }
        }
    });
});

function calculateCurrentVideoTime(room) {
    if (room.playbackState === 'paused') return room.videoTime;
    const elapsedSeconds = (Date.now() - room.lastUpdatedAt) / 1000;
    return room.videoTime + elapsedSeconds;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secure Server running on port ${PORT}`));