import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let botStatus = {
    connected: false,
    phoneNumber: "967775890747",
    pairingCode: null,
    monitoringEnabled: true,
    broadcastsCount: 0
};

// 1. الصفحة الرئيسية (لوحة التحكم التفاعلية للـ APK)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة تحكم البوت</title>
        <style>
            body { font-family: system-ui, sans-serif; background-color: #111827; color: #fff; margin: 0; padding: 20px; }
            .card { background: #1f2937; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            .status { display: inline-block; padding: 6px 12px; border-radius: 20px; font-weight: bold; }
            .online { background: #10b981; color: #fff; }
            .offline { background: #ef4444; color: #fff; }
            .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; }
            .btn-green { background: #10b981; color: white; }
            .btn-red { background: #ef4444; color: white; }
            .btn-blue { background: #3b82f6; color: white; }
            input { width: 100%; padding: 10px; margin-top: 8px; border-radius: 6px; border: 1px solid #374151; background: #374151; color: white; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <h2>لوحة تحكم بوت الواتساب</h2>
        
        <div class="card">
            <h3>حالة الاتصال</h3>
            <p>الوضع: <span class="status ${botStatus.connected ? 'online' : 'offline'}">${botStatus.connected ? 'متصل' : 'غير متصل'}</span></p>
            <p>الرقم الحالي: <b>${botStatus.phoneNumber}</b></p>
            ${botStatus.pairingCode ? `<p>كود الربط: <b style="color:#f59e0b; font-size:18px;">${botStatus.pairingCode}</b></p>` : ''}
        </div>

        <div class="card">
            <h3>إدارة الحساب</h3>
            <label>تغيير رقم الهاتف:</label>
            <input type="text" id="phoneInput" placeholder="مثال: 967775890747">
            <button class="btn btn-blue" onclick="updatePhone()">تحديث الرقم</button>
        </div>

        <div class="card">
            <h3>التحكم بالانضمام والمراقبة</h3>
            <p>الانضمام التلقائي للمجموعات: <b>${botStatus.monitoringEnabled ? 'مفعل ✅' : 'معطل ❌'}</b></p>
            <button class="btn ${botStatus.monitoringEnabled ? 'btn-red' : 'btn-green'}" onclick="toggleMonitoring()">
                ${botStatus.monitoringEnabled ? 'إيقاف الانضمام التلقائي' : 'تشغيل الانضمام التلقائي'}
            </button>
        </div>

        <script>
            function updatePhone() {
                const phone = document.getElementById('phoneInput').value;
                if(!phone) return alert('يرجى إدخال الرقم');
                fetch('/api/update-phone', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phoneNumber: phone })
                }).then(() => location.reload());
            }

            function toggleMonitoring() {
                fetch('/api/toggle-monitoring', { method: 'POST' })
                .then(() => location.reload());
            }
        </script>
    </body>
    </html>
    `);
});

// 2. واجهات الـ API للتحكم من اللوحة
app.get('/api/status', (req, res) => res.json(botStatus));

app.post('/api/toggle-monitoring', (req, res) => {
    botStatus.monitoringEnabled = !botStatus.monitoringEnabled;
    res.json({ success: true, monitoringEnabled: botStatus.monitoringEnabled });
});

app.post('/api/update-phone', (req, res) => {
    const { phoneNumber } = req.body;
    if (phoneNumber) {
        botStatus.phoneNumber = phoneNumber;
        botStatus.connected = false;
        botStatus.pairingCode = null;
    }
    res.json({ success: true, phoneNumber: botStatus.phoneNumber });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
