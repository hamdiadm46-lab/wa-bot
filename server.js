const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');

// ==========================================
// 1. اعدادات خادم الـ API لتطبيق الأندرويد
// ==========================================
const app = express();
app.use(express.json());

// متغيّرات التحكم بحالة البوت
let botStatus = {
    connected: false,
    phoneNumber: "967730536867", // قم بتعديله لرقمك مع المفتاح الدولي بدون +
    pairingCode: null,
    monitoringEnabled: true,
    broadcastsCount: 0
};

// مسار فحص الحالة من التطبيق
app.get('/api/status', (req, res) => {
    res.json(botStatus);
});

// مسار استقبال الأوامر من التطبيق
app.post('/api/command', (req, res) => {
    const { command, text } = req.body;

    if (command === 'toggle_monitoring') {
        botStatus.monitoringEnabled = !botStatus.monitoringEnabled;
        console.log(`[API] تم تغيير حالة المراقبة إلى: ${botStatus.monitoringEnabled}`);
        return res.json({ success: true, monitoringEnabled: botStatus.monitoringEnabled });
    }

    if (command === 'broadcast') {
        console.log(`[API] طلب إرسال نشرة: ${text}`);
        botStatus.broadcastsCount++;
        // هنا يمكنك إضافة دالة الدوران على المجموعات والإرسال
        return res.json({ success: true, message: 'جاري تنفيذ النشرة' });
    }

    res.status(400).json({ success: false, message: 'أمر غير معروف' });
});

// تشغيل خادم Express على البورت المحدد من Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});

// ==========================================
// 2. كود اتصال الواتساب (Baileys)
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // تعطيل الـ QR واستخدام كود الربط
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // توليد كود الربط إذا لم يكن الحساب مسجلاً بعد
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

    // إدارة أحداث الاتصال
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

    // حفظ بيانات الجلسة عند التحديث
    sock.ev.on('creds.update', saveCreds);

    // الاستماع للرسائل القادمة
    sock.ev.on('messages.upsert', async (m) => {
        if (!botStatus.monitoringEnabled) return;
        
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // يمكنك إضافة منطق قراءة كلمات الفلتر والانضمام المباشر هنا
    });
}

// بدء تشغيل البوت
startBot();
