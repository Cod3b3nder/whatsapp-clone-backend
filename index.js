import express from 'express';
import cors from 'cors';
import {
 default as makeWASocket,
 useMultiFileAuthState,
 DisconnectReason,
 proto,
 delay
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());

let sock = null;
let qrCode = null;
let isConnected = false;
const messages = {};
const chats = [];

// QR Code endpoint
app.get('/qr', async (req, res) => {
 if (qrCode) {
 res.send(`<!DOCTYPE html>
 <html>
 <head><title>WhatsApp QR Code</title></head>
 <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f0f0;">
 <div style="text-align: center; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1);">
 <h1 style="margin-bottom: 20px;">📱 Scan with WhatsApp</h1>
 <img src="${qrCode}" alt="QR Code" style="width: 400px; height: 400px; border: 2px solid #25d366;"/>
 <p style="margin-top: 20px; color: #666;">Open WhatsApp on your phone and scan this QR code</p>
 <p style="color: #999; font-size: 14px;">Refresh page for new QR code</p>
 </div>
 </body>
 </html>`);
 } else {
 res.send('<h1>⏳ Waiting for QR code... Refresh the page in a moment</h1>');
 }
});

// Health check
app.get('/health', (req, res) => {
 res.json({ 
 status: isConnected ? 'connected' : 'disconnected',
 qrReady: !!qrCode 
 });
});

// Get all chats
app.get('/chats', (req, res) => {
 const chatList = chats.map(chat => ({
 id: chat,
 name: chat.split('@')[0],
 messageCount: (messages[chat] || []).length
 }));
 res.json({ chats: chatList });
});

// Get messages for a specific chat
app.get('/messages/:chatId', (req, res) => {
 const { chatId } = req.params;
 const fullId = chatId.includes('@') ? chatId : `${chatId}@c.us`;
 res.json({ messages: messages[fullId] || [] });
});

// Send message
app.post('/send', async (req, res) => {
 const { phone, message } = req.body;
 
 if (!sock || !isConnected) {
 return res.status(500).json({ error: 'WhatsApp not connected. Scan QR code first.' });
 }

 if (!phone || !message) {
 return res.status(400).json({ error: 'Missing phone or message' });
 }

 try {
 const phoneNumber = phone.replace(/\D/g, '');
 const jid = `${phoneNumber}@c.us`;
 
 await sock.sendMessage(jid, { text: message });
 
 if (!messages[jid]) messages[jid] = [];
 messages[jid].push({
 from: 'me',
 text: message,
 timestamp: Math.floor(Date.now() / 1000),
 type: 'text'
 });

 res.json({ status: 'sent', jid });
 } catch (error) {
 console.error('Send error:', error);
 res.status(500).json({ error: error.message });
 }
});

// Initialize WhatsApp connection
async function connectWhatsApp() {
 try {
 const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
 
 sock = makeWASocket({
 auth: state,
 logger: pino({ level: 'silent' }),
 printQRInTerminal: false,
 browser: ['WhatsApp Clone', 'Safari', '2.0']
 });

 // Connection updates
 sock.ev.on('connection.update', async (update) => {
 const { connection, lastDisconnect, qr } = update;

 // QR Code generation
 if (qr) {
 try {
 qrCode = await QRCode.toDataURL(qr);
 console.log('📱 QR Code generated. Visit http://localhost:' + port + '/qr');
 } catch (qrErr) {
 console.error('QR generation error:', qrErr);
 }
 }

 // Connection opened
 if (connection === 'open') {
 isConnected = true;
 qrCode = null;
 console.log('✅ WhatsApp connected successfully!');
 }
 // Connection closed
 else if (connection === 'close') {
 isConnected = false;
 const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
 
 console.log('❌ Connection closed. Reason:', lastDisconnect?.error);
 
 if (shouldReconnect) {
 console.log('♻️ Attempting to reconnect...');
 setTimeout(() => connectWhatsApp(), 3000);
 } else {
 console.log('Logged out. Please scan QR code again.');
 }
 }
 // Connecting
 else if (connection === 'connecting') {
 console.log('⏳ Connecting to WhatsApp...');
 }
 });

 // Incoming messages
 sock.ev.on('messages.upsert', async (m) => {
 const msg = m.messages[0];
 
 if (!msg) return;

 // Skip if it's our own message
 if (msg.key.fromMe) return;

 const senderId = msg.key.remoteJid;
 const messageContent = msg.message;

 if (!messageContent) return;

 // Extract text from message
 let text = '';
 if (messageContent.conversation) {
 text = messageContent.conversation;
 } else if (messageContent.extendedTextMessage) {
 text = messageContent.extendedTextMessage.text;
 } else if (messageContent.imageMessage?.caption) {
 text = messageContent.imageMessage.caption;
 } else {
 text = '[Non-text message]';
 }

 // Store message
 if (!messages[senderId]) messages[senderId] = [];
 messages[senderId].push({
 from: senderId,
 text: text,
 timestamp: msg.messageTimestamp,
 type: 'text'
 });

 // Add to chats list if new
 if (!chats.includes(senderId)) {
 chats.push(senderId);
 console.log('💬 New chat:', senderId);
 }

 console.log(`📨 Message from ${senderId}: ${text}`);
 });

 // Credentials updated
 sock.ev.on('creds.update', saveCreds);

 } catch (error) {
 console.error('Connection error:', error);
 console.log('Retrying in 3 seconds...');
 setTimeout(() => connectWhatsApp(), 3000);
 }
}

// Start server
app.listen(port, () => {
 console.log(`🚀 Server running on port ${port}`);
 console.log(`📱 QR Code: http://localhost:${port}/qr`);
 console.log(`📡 Health: http://localhost:${port}/health`);
 connectWhatsApp();
});
