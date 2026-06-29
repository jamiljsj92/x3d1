const express = require('express');
const fetch = require('node-fetch');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = parseInt(process.env.ACCOUNT_ID);
const API_TOKEN = process.env.API_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const YOUR_TELEGRAM_ID = parseInt(process.env.YOUR_TELEGRAM_ID);
const GROUP_ID = parseInt(process.env.GROUP_ID || YOUR_TELEGRAM_ID); // Fallback if needed

if (!CHATWOOT_URL || !ACCOUNT_ID || !API_TOKEN || !TELEGRAM_TOKEN || !YOUR_TELEGRAM_ID) {
    console.error("❌ Missing required environment variables. Please check your Railway vars.");
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const NOTIFICATIONS_FILE = './notifications.json';
const HISTORY_FILE = './performance_history.json';

let notified = new Map();
let historyLogs = []; 
const activeLocks = new Map(); 
const pendingReplies = new Map(); // تتبع حالة المستخدمين المنتظر منهم إدخال رد

const SHIFTS = [
    { name: "مهند", start: 23, end: 4, emoji: "🌙" }, // crosses midnight
    { name: "يحيى", start: 4, end: 9, emoji: "🌅" },
    { name: "وليد ٢", start: 9, end: 14, emoji: "☀️" },
    { name: "وليد", start: 14, end: 19, emoji: "🌞" },
    { name: "سليمان", start: 19, end: 23, emoji: "🌙" }
];

const TEMPLATE_EXCLUSION_TEXT = "تم ارسال رسالة قالب تلقائية";

function loadData() {
    try {
        if (fs.existsSync(NOTIFICATIONS_FILE)) {
            notified = new Map(Object.entries(JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'))));
        }
        if (fs.existsSync(HISTORY_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            historyLogs = Array.isArray(parsed) ? parsed : [];
        } else {
            historyLogs = [];
        }
    } catch (e) {
        historyLogs = [];
    }
}

function saveData() {
    try {
        fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(Object.fromEntries(notified), null, 2));
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.isArray(historyLogs) ? historyLogs : [], null, 2));
    } catch (e) {
        console.error("❌ Error writing state files to disk:", e);
    }
}

loadData();

// ==================== Performance Tracking Metrics Logic ====================
function logPerformanceMilestone(convId, waitMin) {
    if (!Array.isArray(historyLogs)) historyLogs = [];
    
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh', hour: 'numeric', hour12: false }));
    const currentShift = getCurrentShift();
    
    const existing = historyLogs.find(log => log && log.convId === convId && log.shift === currentShift.name && log.waitMin === waitMin);
    if (!existing) {
        historyLogs.push({
            timestamp: Date.now(),
            hourBlock: hour,
            shift: currentShift.name,
            convId: convId,
            waitMin: waitMin
        });
        saveData();
    }
}

function housekeepPerformanceLogs() {
    if (!Array.isArray(historyLogs)) {
        historyLogs = [];
        return;
    }
    const cutOff = Date.now() - (48 * 60 * 60 * 1000);
    historyLogs = historyLogs.filter(log => log && log.timestamp > cutOff);
    saveData();
}

// ==================== Helpers & Formatting ====================
function formatArabicDuration(totalMinutes) {
    if (totalMinutes < 1) return "أقل من دقيقة";
    if (totalMinutes < 60) return `${totalMinutes} دقيقة`;
    
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    
    let hourText = "";
    if (hours === 1) hourText = "ساعة";
    else if (hours === 2) hourText = "ساعتين";
    else if (hours >= 3 && hours <= 10) hourText = `${hours} ساعات`;
    else hourText = `${hours} ساعة`;
    
    let minText = "";
    if (mins > 0) {
        if (mins === 1) minText = "ودقيقة";
        else if (mins === 2) minText = "ودقيقتين";
        else if (mins >= 3 && mins <= 10) minText = `و ${mins} دقائق`;
        else minText = `و ${mins} دقيقة`;
    }
    
    return `${hourText} ${minText}`.trim();
}

async function getMessages(convId) {
    try {
        const res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}/messages`, {
            headers: { 'api_access_token': API_TOKEN },
            timeout: 8000
        });
        const data = await res.json();
        return data.payload || data || [];
    } catch (e) { return []; }
}

async function processAndValidateConversations(rawPayload) {
    const safeList = Array.isArray(rawPayload) ? rawPayload : [];
    
    const validationPromises = safeList.map(async (conv) => {
        const lastMsgText = conv.last_non_activity_message?.content || "";
        if (lastMsgText.includes(TEMPLATE_EXCLUSION_TEXT)) return null; 

        const messages = await getMessages(conv.id);
        const tailMessage = messages.length ? messages[messages.length - 1]?.content || "" : "";
        if (tailMessage.includes(TEMPLATE_EXCLUSION_TEXT)) return null;

        return conv;
    });

    const results = await Promise.all(validationPromises);
    return results.filter(conv => conv !== null);
}

async function getAllOpenConversations() {
    try {
        let allConversations = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations?status=open&page=${page}`, {
                headers: { 'api_access_token': API_TOKEN },
                timeout: 10000
            });
            const data = await res.json();
            
            let pageList = [];
            if (data && data.data && Array.isArray(data.data.payload)) pageList = data.data.payload;
            else if (data && Array.isArray(data.payload)) pageList = data.payload;
            else if (data && Array.isArray(data.data)) pageList = data.data;
            else if (Array.isArray(data)) pageList = data;

            if (pageList.length === 0 || page > 5) { 
                hasMore = false;
            } else {
                allConversations = allConversations.concat(pageList);
                page++;
            }
        }
        
        return await processAndValidateConversations(allConversations);
    } catch (e) { return []; }
}

async function getConversation(convId) {
    try {
        const res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}`, {
            headers: { 'api_access_token': API_TOKEN },
            timeout: 8000
        });
        const data = await res.json();
        let conv = data;
        if (data && data.data && data.data.payload) conv = data.data.payload;
        else if (data && data.data) conv = data.data;
        else if (data && data.payload) conv = data.payload;
        
        const validated = await processAndValidateConversations([conv]);
        return validated.length ? validated[0] : null;
    } catch (e) { return null; }
}

function getCurrentShift() {
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh', hour: 'numeric', hour12: false }));
    // Handle midnight crossing shift
    return SHIFTS.find(s => {
        if (s.start < s.end) {
            return hour >= s.start && hour < s.end;
        } else {
            // Crosses midnight (23 -> 4)
            return hour >= s.start || hour < s.end;
        }
    }) || SHIFTS[0];
}

function parseToSeconds(timestamp) {
    if (!timestamp) return 0;
    if (typeof timestamp === 'number') {
        if (timestamp < 9999999999) return timestamp;
        return Math.floor(timestamp / 1000);
    }
    const parsed = Date.parse(timestamp);
    return isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function getWaitingTime(conv) {
    if (!conv) return 0;
    const now = Math.floor(Date.now() / 1000);

    if (conv.waiting_since) {
        const waitingSinceSec = parseToSeconds(conv.waiting_since);
        const diff = now - waitingSinceSec;
        if (diff > 0 && diff < 500000) return Math.floor(diff / 60); 
    }

    const lastActivity = parseToSeconds(conv.agent_last_seen_at);
    const contactActivity = parseToSeconds(conv.contact_last_seen_at);

    if (contactActivity > lastActivity) {
        const manualDiff = now - contactActivity;
        if (manualDiff > 0 && manualDiff < 500000) return Math.floor(manualDiff / 60);
    }

    return 0;
}

function getAlertLevel(minutes) {
    if (minutes >= 120) return { emoji: "🔥", label: "تأخير حرج" };
    if (minutes >= 60) return { emoji: "🚨", label: "تأخير مرتفع" };
    if (minutes >= 45) return { emoji: "⚠️", label: "تأخير حاد" };
    if (minutes >= 30) return { emoji: "⚠️", label: "تأخير ملحوظ" };
    return { emoji: "⚠️", label: "تحتاج متابعة" };
}

function formatDateTime() {
    const now = new Date();
    const date = now.toLocaleDateString('en-US', { timeZone: 'Asia/Riyadh', month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Riyadh', hour: 'numeric', minute: '2-digit', hour12: true });
    return { date, time };
}

// ==================== API Request to Chatwoot Engine ====================
async function sendMessageToChatwoot(convId, textContent, fileUrl = null, filename = 'attachment') {
    const url = `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}/messages`;
    
    try {
        if (fileUrl) {
            const form = new FormData();
            if (textContent) form.append('content', textContent);
            form.append('message_type', 'outgoing');
            form.append('private', 'false');
            
            const fileRes = await fetch(fileUrl);
            const buffer = await fileRes.buffer();
            form.append('attachments[]', buffer, { filename: filename });
            
            await fetch(url, {
                method: 'POST',
                headers: { 'api_access_token': API_TOKEN, ...form.getHeaders() },
                body: form
            });
        } else {
            await fetch(url, {
                method: 'POST',
                headers: { 
                    'api_access_token': API_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: textContent || "", message_type: "outgoing", private: false })
            });
        }
        return true;
    } catch (e) {
        console.error("Error sending to Chatwoot:", e);
        return false;
    }
}

// ==================== Performance Scorecard Report Generator ====================
async function generateReport(isEndOfShift = false, isWarning = false) {
    const convs = await getAllOpenConversations();
    const shift = getCurrentShift();
    const { date, time } = formatDateTime();
    
    let c15 = 0, c30 = 0, c45 = 0, c60 = 0, c90 = 0, c120 = 0;
    
    convs.forEach(conv => {
        const w = getWaitingTime(conv);
        if (w >= 120) c120++;
        else if (w >= 90) c90++;
        else if (w >= 60) c60++;
        else if (w >= 45) c45++;
        else if (w >= 30) c30++;
        else if (w >= 15) c15++;
    });

    let text = '';
    
    if (isWarning) {
        text = `⚠️ <b>تنبيه قُرب انتهاء فترة العمل</b>\n\n` +
               `👤 <b>الموظف المسؤول:</b> ${shift.emoji} ${shift.name}\n` +
               `⏰ <b>الوقت الحالي:</b> ${time}\n\n` +
               `💬 <b>الوضع الحالي للمحادثات:</b>\n` +
               `• إجمالي المحادثات المعلقة: <b>${convs.length} محادثة</b>\n` +
               `• محادثات تجاوزت 15 دقيقة: <b>${c15} محادثة</b>\n\n` +
               `📢 <i>يرجى إغلاق أو الرد على الحالات المعلقة قبل تسليم الشفت التالي.</i>`;
               
    } else if (isEndOfShift) {
        if (!Array.isArray(historyLogs)) historyLogs = [];
        const logsThisShift = historyLogs.filter(log => log && log.shift === shift.name);
        
        const maxDelayEntry = logsThisShift.reduce((max, p) => (p && p.waitMin > max) ? p.waitMin : max, 0);
        const uniqueViolatingChats = new Set(logsThisShift.filter(l => l && l.convId).map(log => log.convId)).size;
        
        const blocks = [`${shift.start}-${shift.start+2}`, `${shift.start+2}-${shift.start+4}`, `${shift.start+4}-${shift.start+6}`, `${shift.start+6}-${shift.end}`];
        let blockCounters = [0, 0, 0, 0];
        
        logsThisShift.forEach(log => {
            if (!log) return;
            const h = log.hourBlock;
            if (h >= shift.start && h < shift.start + 2) blockCounters[0]++;
            else if (h >= shift.start + 2 && h < shift.start + 4) blockCounters[1]++;
            else if (h >= shift.start + 4 && h < shift.start + 6) blockCounters[2]++;
            else if (h >= shift.start + 6 && h < shift.end) blockCounters[3]++;
            // Handle midnight crossing for logs
            else if (shift.start > shift.end && (h >= shift.start || h < shift.end)) {
                // Simplified for reporting
            }
        });

        text = `📊 <b>تقرير الأداء ونهاية الشفت الرسمي - Aura Bot</b>\n` +
               `🗓️ <b>التاريخ:</b> ${date}\n` +
               `⏰ <b>الفترة:</b> من الساعة ${shift.start}:00 إلى ${shift.end}:00\n\n` +
               
               `👤 <b>الموظف المسؤول عن الفترة:</b>\n` +
               `• الاسم: ${shift.emoji} <b>${shift.name}</b>\n\n` +
               
               `📈 <b>خلاصة الالتزام بمستوى الخدمة (SLA):</b>\n` +
               `• <b>أقصى مدة تأخير سُجلت:</b> ${maxDelayEntry > 0 ? formatArabicDuration(maxDelayEntry) : 'صفر (التزام تام)'}\n` +
               `• <b>عدد العملاء الذين واجهوا تأخيراً:</b> ${uniqueViolatingChats} عميل\n` +
               `• <b>محادثات متبقية ومرحّلة للشفت القادم:</b> ${c15 + c30 + c45 + c60 + c90 + c120} محادثة\n\n` +
               
               `🔥 <b>معدل التأخير حسب الساعات (نظرة عامة):</b>\n` +
               `• الساعات [${blocks[0]}]: رُصد ${blockCounters[0]} تأخير\n` +
               `• الساعات [${blocks[1]}]: رُصد ${blockCounters[1]} تأخير\n` +
               `• الساعات [${blocks[2]}]: رُصد ${blockCounters[2]} تأخير\n` +
               `• الساعات [${blocks[3]}]: رُصد ${blockCounters[3]} تأخير\n\n` +
               
               `📌 <b>إجمالي المحادثات المفتوحة في النظام الآن:</b> ${convs.length}`;
               
        housekeepPerformanceLogs(); 
    } else {
        text = `📋 <b>التقرير الدوري لمتابعة الشفت الحالي - Aura Bot</b>\n\n` +
               `👤 <b>الموظف الحالي:</b> ${shift.emoji} <b>${shift.name}</b>\n` +
               `📌 <b>إجمالي المحادثات المفتوحة:</b> ${convs.length}\n\n` +
               
               `⚠️ <b>تصنيف المحادثات المتأخرة حالياً:</b>\n` +
               `• تأخير لأكثر من 15 دقيقة: <b>${c15}</b>\n` +
               `• تأخير لأكثر من 30 دقيقة: <b>${c30}</b>\n` +
               `• تأخير لأكثر من 45 دقيقة: <b>${c45}</b>\n` +
               `• تأخير لأكثر من ساعة (60+): <b>${c60}</b>\n` +
               `• تأخير حرج جداً (120+): <b>${c120}</b>`;
    }
    
    try {
        await bot.telegram.sendMessage(YOUR_TELEGRAM_ID, text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error("Telegram send error:", err);
    }
}

// ==================== Send Alert ====================
async function sendTelegramAlert(conv, waitMin) {
    if (!conv) return;
    const contact = conv.meta?.sender || conv.contact || {};
    const name = contact.name || contact.phone_number || 'عميل';
    const link = `${CHATWOOT_URL}/app/accounts/${ACCOUNT_ID}/conversations/${conv.id}`;
    
    const messages = await getMessages(conv.id);
    const lastMsg = messages.length ? messages[messages.length-1].content || 'لا يوجد محتوى' : 'لا يوجد محتوى';
    
    const level = getAlertLevel(waitMin);
    const shift = getCurrentShift();
    const { time, date } = formatDateTime();
    
    const text = `${level.emoji} <b>محادثة تحتاج متابعة (${level.label}) - Aura Bot</b>\n\n` +
                 `👥 الموظف المسؤول: ${shift.emoji} <b>${shift.name}</b>\n` +
                 `<a href="${link}">👤 العميل: <b>${name}</b></a>\n` +
                 `🆔 رقم المحادثة: <code>${conv.id}</code>\n` +
                 `⏱️ مدة الانتظار: <b>${formatArabicDuration(waitMin)}</b>\n` + 
                 `💬 آخر رسالة:\n${lastMsg.substring(0, 350)}${lastMsg.length > 350 ? '...' : ''}\n\n` + 
                 `🕒 ${time} | ${date}`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🔄 تحديث الفحص الآن", callback_data: `verify_${conv.id}` }],
                [{ text: "📋 عرض سجل المحادثة كاملاً", callback_data: `summary_${conv.id}` }]
            ]
        }
    };

    try {
        await bot.telegram.sendMessage(YOUR_TELEGRAM_ID, text, { parse_mode: 'HTML', ...keyboard, disable_web_page_preview: true });
        notified.set(String(conv.id), waitMin);
        logPerformanceMilestone(conv.id, waitMin);
        saveData();
    } catch (e) {
        console.error("Failed to send alert telegram:", e);
    }
}

// ==================== Callback Query Handler ====================
bot.on('callback_query', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    const [action, convIdStr] = ctx.callbackQuery.data.split('_');
    const convId = parseInt(convIdStr);
    
    if (action === 'verify') {
        const conv = await getConversation(convId);
        if (!conv || conv.status !== 'open') {
            await ctx.answerCbQuery("✅ تم إغلاق المحادثة أو الرد عليها!");
            try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e){}
            notified.delete(String(convId));
            saveData();
            return;
        }
        
        const waitMin = getWaitingTime(conv);
        if (waitMin < 15) {
            await ctx.answerCbQuery("⏱️ تم التعامل مع العميل ووقت الانتظار تصفّر.");
            try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e){}
            notified.delete(String(convId));
            saveData();
        } else {
            await ctx.answerCbQuery(`⚠️ لا تزال معلقة! انتظار: ${formatArabicDuration(waitMin)}`, { show_alert: true });
        }
    }

    if (action === 'summary') {
        const rawMessages = await getMessages(convId);
        
        if (!rawMessages || rawMessages.length === 0) {
            return await ctx.answerCbQuery("❌ لا توجد رسائل متوفرة في هذه المحادثة.", { show_alert: true });
        }

        const validMessages = rawMessages.filter(m => m.content && m.content.trim() !== "");
        const lastTenMessages = validMessages.slice(-10);

        let latestReplyStatusText = "";
        if (validMessages.length > 0) {
            const absoluteLastMessage = validMessages[validMessages.length - 1];
            if (absoluteLastMessage.message_type === 0) {
                latestReplyStatusText = `⚠️ <b>العميل أرسل تفاصيل جديدة (لم يتم الرد بعد)</b>`;
            } else {
                latestReplyStatusText = `✅ <b>الموظف قدم الرد الأخير على العميل</b>`;
            }
        }

        let chatLogText = `📋 <b>سجل محادثة رقم:</b> <code>${convId}</code>\n` +
                          `${latestReplyStatusText}\n\n`;

        lastTenMessages.forEach(m => {
            if (m.message_type === 0) {
                chatLogText += `👤 ${m.content.trim()}\n\n`;
            } else if (m.message_type === 1) {
                chatLogText += `👨‍💻 ${m.content.trim()}\n\n`;
            }
        });

        const returnKeyboard = {
            inline_keyboard: [
                [
                    { text: "🔙 العودة للتنبيه الأساسي", callback_data: `back_${convId}` },
                    { text: "💬 رد على العميل", callback_data: `reply_${convId}` }
                ]
            ]
        };

        try {
            await ctx.editMessageText(chatLogText, { parse_mode: 'HTML', reply_markup: returnKeyboard });
        } catch (e) {
            await ctx.answerCbQuery("⚠️ المحادثة طويلة جداً، جاري إرسالها كرسالة مستقلة...");
            await bot.telegram.sendMessage(YOUR_TELEGRAM_ID, chatLogText, { parse_mode: 'HTML', reply_markup: returnKeyboard });
        }
    }

    if (action === 'back') {
        const conv = await getConversation(convId);
        if (!conv) return ctx.answerCbQuery("❌ تعذر العثور على المحادثة.");

        const contact = conv.meta?.sender || conv.contact || {};
        const name = contact.name || contact.phone_number || 'عميل';
        const link = `${CHATWOOT_URL}/app/accounts/${ACCOUNT_ID}/conversations/${conv.id}`;
        
        const messages = await getMessages(conv.id);
        const lastMsg = messages.length ? messages[messages.length-1].content || 'لا يوجد محتوى' : 'لا يوجد محتوى';
        
        const waitMin = getWaitingTime(conv);
        const level = getAlertLevel(waitMin);
        const shift = getCurrentShift();
        const { time, date } = formatDateTime();

        const originalText = `${level.emoji} <b>محادثة تحتاج متابعة (${level.label})</b>\n\n` +
                             `👥 الموظف المسؤول: ${shift.emoji} <b>${shift.name}</b>\n` +
                             `<a href="${link}">👤 العميل: <b>${name}</b></a>\n` +
                             `🆔 رقم المحادثة: <code>${conv.id}</code>\n` +
                             `⏱️ مدة الانتظار: <b>${formatArabicDuration(waitMin)}</b>\n` + 
                             `💬 آخر رسالة:\n${lastMsg.substring(0, 350)}${lastMsg.length > 350 ? '...' : ''}\n\n` + 
                             `🕒 ${time} | ${date}`;

        const originalKeyboard = {
            inline_keyboard: [
                [{ text: "🔄 تحديث الفحص الآن", callback_data: `verify_${conv.id}` }],
                [{ text: "📋 عرض سجل المحادثة كاملاً", callback_data: `summary_${conv.id}` }]
            ]
        };

        try {
            await ctx.editMessageText(originalText, { parse_mode: 'HTML', reply_markup: originalKeyboard, disable_web_page_preview: true });
        } catch (e) {}
    }

    if (action === 'reply') {
        pendingReplies.set(ctx.from.id, convId);
        await ctx.answerCbQuery();
        await ctx.reply(`💬 <b>جاري الرد على المحادثة رقم:</b> <code>${convId}</code>\n\nأرسل رسالتك الآن (نص، صورة، أو ملف). أو أرسل /cancel للإلغاء.`, { parse_mode: 'HTML' });
    }
});

// ==================== Handling Incoming Multi-type Replies ====================
bot.command('cancel', (ctx) => {
    if (pendingReplies.has(ctx.from.id)) {
        pendingReplies.delete(ctx.from.id);
        ctx.reply("❌ تم إلغاء وضع الرد.");
    }
});

bot.on(['text', 'photo', 'document'], async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;

    let targetConvId = null;

    if (pendingReplies.has(ctx.from.id)) {
        targetConvId = pendingReplies.get(ctx.from.id);
    } 
    else if (ctx.message.reply_to_message) {
        const replyToText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
        const match = replyToText.match(/(?:رقم المحادثة:|سجل محادثة رقم:)\s*(\d+)/);
        if (match) targetConvId = parseInt(match[1]);
    }

    if (!targetConvId) return;

    const content = ctx.message.text || ctx.message.caption || "";
    let fileUrl = null;
    let filename = 'attachment';

    try {
        await ctx.sendChatAction('typing');

        if (ctx.message.photo) {
            const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            fileUrl = await ctx.telegram.getFileLink(fileId);
            filename = 'image.jpg';
        } else if (ctx.message.document) {
            const fileId = ctx.message.document.file_id;
            fileUrl = await ctx.telegram.getFileLink(fileId);
            filename = ctx.message.document.file_name || 'document';
        }

        const success = await sendMessageToChatwoot(targetConvId, content, fileUrl, filename);

        if (success) {
            ctx.reply(`✅ <b>تم إرسال ردك بنجاح للعميل!</b> (رقم المحادثة: <code>${targetConvId}</code>)`, { parse_mode: 'HTML' });
            pendingReplies.delete(ctx.from.id); 
        } else {
            ctx.reply("❌ حدث خطأ أثناء إرسال الرد المخصص لـ Chatwoot.");
        }
    } catch (e) {
        console.error("Failed to process attachment response:", e);
        ctx.reply("❌ فشل معالجة وإرسال المرفقات.");
    }
});

// ==================== HTML Based Commands ====================
bot.start((ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply(`✅ <b>Aura Bot يعمل بنجاح</b>\n\n` +
              `📋 الأوامر المتاحة:\n\n` +
              `<b>/start</b> - معلومات البوت\n` +
              `<b>/health</b> - حالة البوت\n` +
              `<b>/pending</b> - قائمة المعلقين بالأرقام\n` +
              `<b>/pending_links</b> - روابط المحادثات مصنفة حسب الوقت 🔗\n` +
              `<b>/stats</b> - ملخص سريع بالأرقام\n` +
              `<b>/report</b> - تقرير مفصل الآن\n` +
              `<b>/detail_report</b> - بطاقة أداء الشفت التحليلية العميقة`, { parse_mode: 'HTML' });
});

bot.command('health', (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply(`✅ Aura Bot مستقر.\n• جلب تحديثات تيليجرام: منفذ مستقل /telegram-webhook\n• منع التكرار: مفعل\n• تنسيق البيانات: HTML Engine Safe`, { parse_mode: 'HTML' });
});

bot.command('pending', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply("📋 جاري جلب وقراءة قائمة الانتظار الحالية...");
    const convs = await getAllOpenConversations();
    
    const sortedConvs = convs.sort((a, b) => getWaitingTime(b) - getWaitingTime(a));
    const shift = getCurrentShift();
    let text = `📋 <b>المحادثات المنتظرة مرتبة من الأقدم للأحدث (≥ 15 دقيقة) - Aura Bot</b>\n`;
    text += `👥 الموظف المسؤول الحالي: <b>${shift.name}</b>\n\n`;
    let count = 0;
    
    for (const conv of sortedConvs) {
        const wait = getWaitingTime(conv);
        if (wait >= 15) {
            text += `🆔 <code>${conv.id}</code> | ⏱️ ${formatArabicDuration(wait)}\n`;
            count++;
            if (count >= 25) break;
        }
    }
    if (count === 0) text += "لا توجد محادثات منتظرة حالياً.";
    ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('pending_links', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply("🔍 جاري فحص وتصنيف روابط المحادثات المتأخرة...");
    
    const convs = await getAllOpenConversations();
    const shift = getCurrentShift();
    
    let list15 = [], list30 = [], list45 = [], list60 = [];
    const sortedConvs = convs.sort((a, b) => getWaitingTime(b) - getWaitingTime(a));
    
    sortedConvs.forEach(conv => {
        const w = getWaitingTime(conv);
        const contact = conv.meta?.sender || conv.contact || {};
        const name = contact.name || 'عميل';
        const linkStr = `<a href="${CHATWOOT_URL}/app/accounts/${ACCOUNT_ID}/conversations/${conv.id}">🔗 ${name} (${conv.id})</a> - ⏱️ ${w} د`;
        
        if (w >= 60) list60.push(linkStr);
        else if (w >= 45) list45.push(linkStr);
        else if (w >= 30) list30.push(linkStr);
        else if (w >= 15) list15.push(linkStr);
    });
    
    let text = `📂 <b>روابط المحادثات المعلقة مصنفة بالتفصيل (مرتبة بالأقدم) - Aura Bot</b>\n`;
    text += `👥 شفت الحالي: <b>${shift.name}</b>\n\n`;
    
    text += `🔴 <b>فئة 60+ دقيقة (${list60.length}):</b>\n`;
    text += list60.length ? list60.join('\n') : '_لا يوجد_\n';
    text += `\n`;
    
    text += `🟠 <b>فئة 45+ دقيقة (${list45.length}):</b>\n`;
    text += list45.length ? list45.join('\n') : '_لا يوجد_\n';
    text += `\n`;
    
    text += `🟡 <b>فئة 30+ دقيقة (${list30.length}):</b>\n`;
    text += list30.length ? list30.join('\n') : '_لا يوجد_\n';
    text += `\n`;
    
    text += `🟢 <b>فئة 15+ دقيقة (${list15.length}):</b>\n`;
    text += list15.length ? list15.join('\n') : '_لا يوجد_';
    
    ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('stats', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    const convs = await getAllOpenConversations();
    const shift = getCurrentShift();
    let c15=0, c30=0, c45=0, c60=0; 
    
    convs.forEach(c => {
        const w = getWaitingTime(c);
        if (w >= 60) c60++;
        else if (w >= 45) c45++; 
        else if (w >= 30) c30++;
        else if (w >= 15) c15++;
    });
    
    ctx.reply(`📊 <b>ملخص سريع - Aura Bot</b>\n\n` +
              `👥 الموظف المسؤول: <b>${shift.name}</b>\n` +
              `المفتوحة الإجمالية: ${convs.length}\n` +
              `15+ دقيقة: ${c15}\n` +
              `30+ دقيقة: ${c30}\n` +
              `45+ دقيقة: ${c45}\n` + 
              `60+ دقيقة: ${c60}`, { parse_mode: 'HTML' });
});

bot.command('report', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply("📋 جاري إنشاء التقرير الفوري الشامل...");
    await generateReport(false);
});

bot.command('detail_report', async (ctx) => {
    if (ctx.from.id !== YOUR_TELEGRAM_ID) return;
    ctx.reply("📊 جاري احتساب بطاقة الأداء التحليلية...");
    await generateReport(true);
});

// ==================== Core Monitoring Logic ====================
async function checkConversation(convId) {
    try {
        const conv = await getConversation(convId);
        if (!conv || conv.status !== 'open') {
            if (notified.has(String(convId))) {
                notified.delete(String(convId));
                saveData();
            }
            return;
        }
        
        const waitMin = getWaitingTime(conv);
        if (waitMin < 15) {
            if (notified.has(String(convId))) {
                notified.delete(String(convId));
                saveData();
            }
            return;
        }

        let targetThreshold = 15;
        const thresholds = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240];
        
        for (const t of thresholds) {
            if (waitMin >= t) targetThreshold = t;
        }
        if (waitMin > 240) {
            targetThreshold = Math.floor(waitMin / 30) * 30;
        }

        const lastNotifiedThreshold = notified.get(String(convId)) || 0;
        
        if (targetThreshold > lastNotifiedThreshold) {
            await sendTelegramAlert(conv, waitMin);
        }
    } catch (e) {
        console.error("Error checking conversation:", e);
    }
}

// Background Tracker Loop (Checks SLA Every 60s)
setInterval(async () => {
    const convs = await getAllOpenConversations();
    const sortedConvs = convs.sort((a, b) => getWaitingTime(b) - getWaitingTime(a));

    for (const conv of sortedConvs) {
        if(conv && conv.id) await checkConversation(conv.id);
    }
}, 60000);

// Shift Notification Window Interval - Updated for new shifts
setInterval(() => {
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh', hour: 'numeric', hour12: false }));
    const min = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh', minute: 'numeric' }));
    
    // Warning at :30 before shift ends
    if (min === 30 && [3, 8, 13, 18, 22].includes(hour)) {  // Adjusted for new shifts
        generateReport(false, true); 
    }
    // End of shift reports
    if (min === 0 && [4, 9, 14, 19, 23].includes(hour)) {
        generateReport(true); 
    }
    // Periodic reports
    if (min === 0 && [0, 5, 10, 15, 20].includes(hour)) {
        generateReport(false); 
    }
}, 60000);

// ==================== API Route Endpoints ====================
app.post('/telegram-webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (err) {
        console.error("Error processing telegram update:", err);
        if (!res.headersSent) res.sendStatus(500);
    }
});

app.post('/webhook', (req, res) => {
    const event = req.body.event;
    if (['conversation_created','conversation_updated','conversation_status_changed','message_created'].includes(event)) {
        const conv = req.body.conversation || req.body.data || req.body;
        
        if (conv?.id) {
            const now = Date.now();
            const lastExecution = activeLocks.get(conv.id) || 0;
            
            if (now - lastExecution < 10000) {
                return res.status(200).send('throttled');
            }
            
            activeLocks.set(conv.id, now);
            setTimeout(() => {
                checkConversation(conv.id);
                activeLocks.delete(conv.id); 
            }, 5000);
        }
    }
    res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Aura Bot SLA Webhook Engine operating on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
