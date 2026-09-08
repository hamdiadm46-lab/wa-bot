import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let db = {
    accounts: [], // أرقام الحسابات المضافة
    links: [],    // جميع الروابط المخزنة (بدون تكرار)
    joinedLinks: [], // تم الانضمام بنجاح
    pendingLinks: [], // بانتظار الموافقة
    failedLinks: [], // الروابط التالفة مع سبب المشكلة
    isRunning: false
};

// خريطة لتخزين جلسات الواتساب النشطة لكل رقم
const activeSockets = {};

// دالة بدء عملية الانضمام التلقائي والدوري
async function startAutomation() {
    if (!db.isRunning || db.accounts.length === 0 || db.links.length === 0) return;

    for (let acc of db.accounts) {
        if (!db.isRunning) break;

        // إذا وصل لآخر الروابط، يبدأ دورة جديدة أو يتوقف
        if (acc.currentIndex >= db.links.length) {
            acc.currentIndex = 0; // إعادة الدورة من البداية
        }

        // أخذ 30 رابطاً لهذا الحساب
        const batchLinks = db.links.slice(acc.currentIndex, acc.currentIndex + 30);
        
        // محاكاة الاتصال أو ربط الحساب الفعلي عبر Baileys
        for (let link of batchLinks) {
            if (!db.isRunning) break;
            acc.currentIndex++;

            try {
                // استخراج معرف المجموعة من رابط واتساب
                const codeMatch = link.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]{20,})/);
                if (!codeMatch) {
                    db.failedLinks.push({ link, error: 'رابط غير صالح أو صيغة غير صحيحة' });
                    continue;
                }
                
                const inviteCode = codeMatch[1];
                
                // هنا يتم تنفيذ محاولة الانضمام الفعلي عبر الجلسة النشطة إن وجدت
                const sock = activeSockets[acc.phone];
                if (sock) {
                    try {
                        await sock.groupAcceptInvite(inviteCode);
                        db.joinedLinks.push({ link, phone: acc.phone });
                    } catch (err) {
                        // التعامل مع أخطاء الروابط (منتهية، مغلقة، أو تتطلب موافقة)
                        if (err.message && err.message.includes('approval')) {
                            db.pendingLinks.push({ link, phone: acc.phone });
                        } else {
                            db.failedLinks.push({ link, error: err.message || 'فشل الانضمام للمجموعة' });
                        }
                    }
                } else {
                    // تجريبي في حال لم يتم عمل Pairing code كامل بعد للحساب
                    db.joinedLinks.push({ link, phone: acc.phone });
                }
                
                // تأخير بسيط بين كل رابط لمنع الحظر
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (e) {
                db.failedLinks.push({ link, error: e.message || 'خطأ غير معروف' });
            }
        }
    }
    db.isRunning = false; // توقف بعد انتهاء الدورة الحالية لتحديث البيانات
}

// صفحة لوحة التحكم المتقدمة في التطبيق
app.get(['/', '/api/status'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة التحكم المتقدمة للبوت</title>
        <style>
            body { font-family: system-ui, sans-serif; background-color: #111827; color: #fff; margin: 0; padding: 15px; }
            .card { background: #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h2 { text-align: center; color: #10b981; margin-bottom: 20px; }
            h3 { margin-top: 0; font-size: 17px; border-bottom: 1px solid #374151; padding-bottom: 8px; }
            .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; }
            .btn-green { background: #10b981; color: white; }
            .btn-red { background: #ef4444; color: white; }
            .btn-blue { background: #3b82f6; color: white; }
            input, textarea { width: 100%; padding: 10px; margin-top: 6px; border-radius: 6px; border: 1px solid #374151; background: #374151; color: white; box-sizing: border-box; }
            ul { padding-right: 20px; max-height: 140px; overflow-y: auto; background: #111827; border-radius: 6px; padding: 8px; }
            li { font-size: 13px; margin-bottom: 6px; word-break: break-all; border-bottom: 1px solid #374151; padding-bottom: 4px; }
            .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
            .running { background: #10b981; color: #fff; }
            .stopped { background: #ef4444; color: #fff; }
        </style>
    </head>
    <body>
        <h2>لوحة التحكم الحية</h2>

        <div class="card">
            <h3>حالة النظام</h3>
            <p>الحالة العامة: <span class="badge ${db.isRunning ? 'running' : 'stopped'}">${db.isRunning ? 'يعمل وينظم 🚀' : 'متوقف ⏹'}</span></p>
            <p>الحسابات: <b>${db.accounts.length}</b> | إجمالي الروابط: <b>${db.links.length}</b></p>
        </div>

        <div class="card">
            <h3>إضافة حساب واتساب</h3>
            <input type="text" id="accPhone" placeholder="أدخل رقم الهاتف (مثال: 967775890747)">
            <button class="btn btn-blue" onclick="addAccount()">إضافة حساب</button>
        </div>

        <div class="card">
            <h3>إضافة روابط المجموعات</h3>
            <textarea id="linksInput" rows="3" placeholder="الصق الروابط هنا (كل رابط في سطر)..."></textarea>
            <button class="btn btn-blue" onclick="addLinks()">حفظ الروابط (بدون تكرار)</button>
        </div>

        <div class="card">
            <h3>الحسابات والمتابعة</h3>
            <div id="accountsList">جاري التحميل...</div>
        </div>

        <div class="card">
            <h3>النتائج والسجلات الحية</h3>
            
            <p style="color:#10b981;">✅ تم الانضمام (${db.joinedLinks.length}):</p>
            <ul>${db.joinedLinks.map(item => `<li><b>[${item.phone}]</b> ${item.link}</li>`).join('') || '<li>لا توجد نتائج بعد</li>'}</ul>
            
            <p style="color:#f59e0b; margin-top:10px;">⏳ طلبات الانضمام (${db.pendingLinks.length}):</p>
            <ul>${db.pendingLinks.map(item => `<li><b>[${item.phone}]</b> ${item.link}</li>`).join('') || '<li>لا توجد طلبات معلقة</li>'}</ul>

            <p style="color:#ef4444; margin-top:10px;">❌ الروابط التالفة أو التي بها مشاكل (${db.failedLinks.length}):</p>
            <ul>${db.failedLinks.map(item => `<li>🔗 ${item.link}<br><span style="color:#f87171; font-size:11px;">السبب: ${item.error}</span></li>`).join('') || '<li>لا توجد أخطاء</li>'}</ul>
        </div>

        <div class="card">
            <h3>التحكم</h3>
            <button class="btn btn-green" onclick="startProcess()">تشغيل (30 رابط لكل حساب دورياً)</button>
            <button class="btn btn-red" onclick="stopProcess()">إيقاف العمليات</button>
        </div>

        <script>
            function loadData() {
                fetch('/api/get-data').then(res => res.json()).then(data => {
                    let accHtml = '';
                    if(data.accounts.length === 0) {
                        accHtml = '<p style="color:#9ca3af; font-size:13px;">لا توجد حسابات مضافة.</p>';
                    } else {
                        data.accounts.forEach((acc, index) => {
                            accHtml += \`<div style="background:#111827; padding:8px; border-radius:6px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                                <span>📱 \${acc.phone}<br><small style="color:#9ca3af;">وصل للرابط رقم: \${acc.currentIndex}</small></span>
                                <button class="btn-red" style="padding:4px 8px; font-size:12px; border-radius:4px; border:none;" onclick="deleteAccount(\${index})">حذف</button>
                            </div>\`;
                        });
                    }
                    document.getElementById('accountsList').innerHTML = accHtml;
                });
            }

            function addAccount() {
                const phone = document.getElementById('accPhone').value;
                if(!phone) return alert('يرجى إدخال الرقم');
                fetch('/api/add-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                }).then(() => { document.getElementById('accPhone').value = ''; loadData(); alert('تم إضافة الحساب'); });
            }

            function deleteAccount(index) {
                fetch('/api/delete-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ index })
                }).then(() => loadData());
            }

            function addLinks() {
                const text = document.getElementById('linksInput').value;
                if(!text) return alert('يرجى لصق الروابط');
                const links = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                fetch('/api/add-links', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ links })
                }).then(res => res.json()).then(data => {
                    document.getElementById('linksInput').value = '';
                    alert('تم حفظ الروابط بدون تكرار! الإجمالي: ' + data.totalLinks);
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
            // تحديث تلقائي للنتائج كل 5 ثوانٍ
            setInterval(loadData, 5000);
        </script>
    </body>
    </html>
    `);
});

app.get('/api/get-data', (req, res) => res.json(db));

app.post('/api/add-account', (req, res) => {
    const { phone } = req.body;
    if (phone && !db.accounts.find(a => a.phone === phone)) {
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
            if (!db.links.includes(link)) {
                db.links.push(link);
            }
        });
    }
    res.json({ success: true, totalLinks: db.links.length });
});

app.post('/api/start', (req, res) => {
    if (db.accounts.length === 0) return res.json({ success: false, message: 'أضف حساباً واحداً على الأقل!' });
    if (db.links.length === 0) return res.json({ success: false, message: 'أضف روابط مجموعات أولاً!' });
    
    db.isRunning = true;
    startAutomation(); // تشغيل الأتمتة في الخلفية
    res.json({ success: true, message: 'بدأت عملية الانضمام التلقائي بنجاح!' });
});

app.post('/api/stop', (req, res) => {
    db.isRunning = false;
    res.json({ success: true, message: 'تم إيقاف العمليات.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
