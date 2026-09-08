const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ استبدل القيم التالية ببياناتك الحقيقية
const TELEGRAM_TOKEN = '8851852954:AAFodYLJ-weYJhRya3pauO1UYdktpFZ9FM4';
const ADMIN_CHAT_ID = '7640301049';
const PHONE_NUMBER = '967775890747'; // رقم الواتساب بدون +

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let sock = null;

app.get('/', (req, res) => {
    res.send('WhatsApp & Telegram Bot Service is Active!');
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // طلب كود الاقتران إذا لم تكن الأجهزة مرتبطة
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                bot.sendMessage(ADMIN_CHAT_ID, `🔑 **كود اقتران الواتساب الخاص بك:**\n\`${code}\``, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error('Error requesting pairing code:', err);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            bot.sendMessage(ADMIN_CHAT_ID, '⚠️ تم انقطاع الاتصال بالواتساب، جاري إعادة المحاولة...');
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            bot.sendMessage(ADMIN_CHAT_ID, '✅ **تم الاتصال بنجاح بالواتساب!** البوت يعمل الآن.');
        }
    });

    // الاستماع لرسائل الواتساب الواردة وإرسال إشعار للتلجرام
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'محتوى غير نصي';
                    
                    const alertMsg = `📩 **رسالة واتساب جديدة:**\n👤 **من:** \`${sender}\`\n💬 **الرسالة:** ${text}`;
                    bot.sendMessage(ADMIN_CHAT_ID, alertMsg, { parse_mode: 'Markdown' });
                }
            }
        }
    });
}

// ----------------- أوامر بوت التلجرام -----------------

// أمر /start
bot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
    bot.sendMessage(msg.chat.id, '🤖 أهلاً بك في لوحة تحكم بوت الواتساب.\n\nالأوامر المتاحة:\n/status - فحص حالة الاتصال\n/send [الرقم] [النص] - إرسال رسالة واتساب');
});

// أمر /status
bot.onText(/\/status/, (msg) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
    if (sock && sock.user) {
        bot.sendMessage(msg.chat.id, `✅ متصل حالياً برقم: ${sock.user.id.split(':')[0]}`);
    } else {
        bot.sendMessage(msg.chat.id, '❌ السيرفر غير متصل بالواتساب حالياً.');
    }
});

// أمر الإرسال /send 967xxxxxxxxx السلام عليكم
bot.onText(/\/send (\d+) (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const targetPhone = match[1] + '@s.whatsapp.net';
    const messageText = match[2];

    if (sock) {
        try {
            await sock.sendMessage(targetPhone, { text: messageText });
            bot.sendMessage(msg.chat.id, `✅ تم إرسال الرسالة بنجاح إلى \`${match[1]}\``, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(msg.chat.id, `❌ فشل إرسال الرسالة: ${err.message}`);
        }
    } else {
        bot.sendMessage(msg.chat.id, '❌ الواتساب غير متصل حالياً.');
    }
});

connectToWhatsApp();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
