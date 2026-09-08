import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// هيكل البيانات المتقدم لإدارة الحسابات والروابط والعمليات
let db = {
    accounts: [], // قائمة الحسابات المضافة
    links: [],    // جميع الروابط المخزنة (بدون تكرار)
    joinedLinks: [], // الروابط التي تم الانضمام إليها بنجاح
    pendingLinks: [], // روابط بانتظار الموافقة (طلب انضمام)
    isRunning: false, // حالة التشغيل الإجمالية
    activeAccountIndex: 0 // مؤشر الحساب الحالي في الدورة
};

// صفحة لوحة التحكم التفاعلية الشاملة
app.get(['/', '/api/status'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة تحكم بوت الواتساب المتقدمة</title>
        <style>
            body { font-family: system-ui, sans-serif; background-color: #111827; color: #fff; margin: 0; padding: 15px; }
            .card { background: #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h2 { text-align: center; color: #10b981; margin-bottom: 20px; }
            h3 { margin-top: 0; font-size: 17px; border-bottom: 1px solid #374151; padding-bottom: 8px; }
            .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; }
            .btn-green { background: #10b981; color: white; }
            .btn-red { background: #ef4444; color: white; }
            .btn-blue { background: #3b82f6; color: white; }
            .btn-gray { background: #4b5563; color: white; }
            input, textarea { width: 100%; padding: 10px; margin-top: 6px; border-radius: 6px; border: 1px solid #374151; background: #374151; color: white; box-sizing: border-box; }
            ul { padding-right: 20px; max-height: 120px; overflow-y: auto; background: #111827; border-radius: 6px; padding: 8px; }
            li { font-size: 13px; margin-bottom: 4px; word-break: break-all; }
            .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
            .running { background: #10b981; color: #fff; }
            .stopped { background: #ef4444; color: #fff; }
        </style>
    </head>
    <body>
        <h2>لوحة التحكم المتقدمة</h2>

        <!-- حالة التشغيل والحسابات -->
        <div class="card">
            <h3>حالة النظام</h3>
            <p>الحالة العامة: <span class="badge ${db.isRunning ? 'running' : 'stopped'}">${db.isRunning ? 'يعمل 🚀' : 'متوقف ⏹'}</span></p>
            <p>إجمالي الحسابات: <b>${db.accounts.length}</b> | إجمالي الروابط: <b>${db.links.length}</b></p>
        </div>

        <!-- إضافة حساب واتساب -->
        <div class="card">
            <h3>إضافة حساب واتساب</h3>
            <input type="text" id="accPhone" placeholder="أدخل رقم الهاتف (مثال: 967775890747)">
            <button class="btn btn-blue" onclick="addAccount()">إضافة حساب جديد</button>
        </div>

        <!-- إضافة روابط المجموعات -->
        <div class="card">
            <h3>إضافة روابط المجموعات</h3>
            <textarea id="linksInput" rows="3" placeholder="الصق الروابط هنا (كل رابط في سطر)..."></textarea>
            <button class="btn btn-blue" onclick="addLinks()">حفظ الروابط (بدون تكرار)</button>
        </div>

        <!-- عرض الحسابات -->
        <div class="card">
            <h3>قائمة الحسابات المضافة</h3>
            <div id="accountsList">جاري التحميل...</div>
        </div>

        <!-- أزرار الإحصائيات (تم الانضمام / طلب انضمام) -->
        <div class="card">
            <h3>سجل الانضمام والطلبات</h3>
            <p>✅ تم الانضمام (${db.joinedLinks.length}):</p>
            <ul>${db.joinedLinks.map(l => `<li>${l}</li>`).join('') || '<li>لا توجد روابط</li>'}</ul>
            
            <p style="margin-top:10px;">⏳ طلبات الانضمام (${db.pendingLinks.length}):</p>
            <ul>${db.pendingLinks.map(l => `<li>${l}</li>`).join('') || '<li>لا توجد طلبات</li>'}</ul>
        </div>

        <!-- أزرار التشغيل والإيقاف -->
        <div class="card">
            <h3>التحكم بعمليات الانضمام</h3>
            <button class="btn btn-green" onclick="startProcess()">تشغيل (30 رابط لكل حساب دورياً)</button>
            <button class="btn btn-red" onclick="stopProcess()">إيقاف العمليات</button>
        </div>

        <script>
            // جلب البيانات وتحديث الواجهة تلقائياً
            function loadData() {
                fetch('/api/get-data')
                .then(res => res.json())
                .then(data => {
                    let accHtml = '';
                    if(data.accounts.length === 0) {
                        accHtml = '<p style="color:#9ca3af; font-size:13px;">لا توجد حسابات مضافة حالياً.</p>';
                    } else {
                        data.accounts.forEach((acc, index) => {
                            accHtml += \`<div style="background:#111827; padding:8px; border-radius:6px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                                <span>📱 \${acc.phone} (وصل لـ: رابط \${acc.currentIndex})</span>
                                <button class="btn-red" style="padding:4px 8px; font-size:12px; border-radius:4px; border:none;" onclick="deleteAccount(\${index})">حذف</button>
                            </div>\`;
                        });
                    }
                    document.getElementById('accountsList').innerHTML = accHtml;
                });
            }

            function addAccount() {
                const phone = document.getElementById('accPhone').value;
                if(!phone) return alert('يرجى إدخال رقم الهاتف');
                fetch('/api/add-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                }).then(() => { document.getElementById('accPhone').value = ''; loadData(); alert('تم إضافة الحساب بنجاح'); });
            }

            function deleteAccount(index) {
                if(confirm('هل أنت متأكد من حذف هذا الحساب؟')) {
                    fetch('/api/delete-account', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ index })
                    }).then(() => loadData());
                }
            }

            function addLinks() {
                const text = document.getElementById('linksInput').value;
                if(!text) return alert('يرجى لصق الروابط أولاً');
                const links = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                fetch('/api/add-links', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ links })
                }).then(res => res.json()).then(data => {
                    document.getElementById('linksInput').value = '';
                    alert('تمت إضافة الروابط بنجاح بدون تكرار! العدد الإجمالي: ' + data.totalLinks);
                    location.reload();
                });
            }

            function startProcess() {
                fetch('/api/start', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            function stopProcess() {
                fetch('/api/stop', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            loadData();
        </script>
    </body>
    </html>
    `);
});

// APIs للتحكم الخلفي
app.get('/api/get-data', (req, res) => {
    res.json(db);
});

app.post('/api/add-account', (req, res) => {
    const { phone } = req.body;
    if (phone) {
        db.accounts.push({ phone, currentIndex: 0 });
    }
    res.json({ success: true, accounts: db.accounts });
});

app.post('/api/delete-account', (req, res) => {
    const { index } = req.body;
    if (index >= 0 && index < db.accounts.length) {
        db.accounts.splice(index, 1);
    }
    res.json({ success: true, accounts: db.accounts });
});

app.post('/api/add-links', (req, res) => {
    const { links } = req.body;
    if (links && Array.isArray(links)) {
        links.forEach(link => {
            // حفظ الروابط بدون تكرار
            if (!db.links.includes(link)) {
                db.links.push(link);
            }
        });
    }
    res.json({ success: true, totalLinks: db.links.length });
});

app.post('/api/start', (req, res) => {
    if (db.accounts.length === 0) {
        return res.json({ success: false, message: 'لا توجد حسابات مضافة للبدء!' });
    }
    if (db.links.length === 0) {
        return res.json({ success: false, message: 'لا توجد روابط مضافة للبدء!' });
    }
    db.isRunning = true;
    res.json({ success: true, message: 'تم تشغيل نظام الانضمام الدوري (30 رابط لكل حساب بنجاح)!' });
});

app.post('/api/stop', (req, res) => {
    db.isRunning = false;
    res.json({ success: true, message: 'تم إيقاف عمليات الانضمام بنجاح.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
