import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';

// ==========================================
// 1. إعدادات خادم الـ API لتطبيق الأندرويد
// ==========================================
const app = express();
app.use(express.json());

let botStatus = {
    connected: false,
    phoneNumber: "967775890747", // رقمك مع المفتاح الدولي بدون +
    pairingCode: null,
    monitoringEnabled: true,
    broadcastsCount: 0
};

app.get('/api/status', (req, res) => {
    res.json(botStatus);
});

app.post('/api/command', (req, res) => {
    const { command, text } = req.body;

    if (command === 'toggle_monitoring') {
        botStatus.monitoringEnabled = !botStatus.monitoringEnabled;
        console.log(`[API] حالة المراقبة: ${botStatus.monitoringEnabled}`);
        return res.json({ success: true, monitoringEnabled: botStatus.monitoringEnabled });
    }

    if (command === 'broadcast') {
        console.log(`[API] طلب إرسال نشرة: ${text}`);
        botStatus.broadcastsCount++;
        return res.json({ success: true, message: 'جاري تنفيذ النشرة' });
    }

    res.status(400).json({ success: false, message: 'أمر غير معروف' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});

// ==========================================
// 2. كود اتصال الواتساب (Baileys ESM)
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(botStatus.phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                botStatus.pairingCode = code;
                
                console.log("\n========================================");
                console.log(`📱 الرقم: ${botStatus.phoneNumber}`);
                console.log(`🔑 كود الربط الخاص بك: ${code}`);
                console.log("========================================\n");
            } catch (err) {
                console.error("فشل في طلب كود الربط:", err);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            botStatus.connected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ تم قطع الاتصال، جاري إعادة المحاولة...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            botStatus.connected = true;
            botStatus.pairingCode = null;
            console.log('✅ تم الاتصال بالواتساب بنجاح!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (!botStatus.monitoringEnabled) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
    });
}

startBot();
