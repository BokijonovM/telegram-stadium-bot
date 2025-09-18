import 'dotenv/config';
import {
    Bot,
    InlineKeyboard,
    Keyboard,
    session
} from 'grammy';
import {
    dayjs,
    formatDate,
    parseDateTime,
    hoursList
} from './time.js';
import {
    db,
    getSlots,
    ensureSlots,
    decrementSlot,
    insertBooking,
    getUserActiveBookings,
    getBookingById,
    cancelBooking,
    listBookingsByDate,
    toggleBlock
} from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));


function isAdmin(ctx) {
    return ADMIN_IDS.has(String(ctx.from?.id));
}


// ---- session state: { pending: { date, hour }, fioPending: true|false }
bot.use(session({
    initial: () => ({})
}));


const OPEN_HOUR = Number(process.env.OPEN_HOUR || 9);
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 23);


function dayPickerKb() {
    return new InlineKeyboard()
        .text('Bugun', `day:0`).text('Ertaga', `day:1`).row()
        .text('Keyingi 7 kun', `days:7`).row()
        .text('Mening bandlarim', `my:bookings`)
        .row()
        .text('Yordam', `help`)
        .row()
        .text('Admin', `admin:menu`);
}

function slotKeyboard(date) {
    ensureSlots(date);
    const rows = getSlots(date);
    const kb = new InlineKeyboard();
    for (const s of rows) {
        const mark = s.is_blocked ? '⛔️' : s.remaining >= 2 ? '🟢2' : s.remaining === 1 ? '🟡1' : '🔴0';
        kb.text(`${s.hour} ${mark}`, `pick:${date}:${s.hour}`).row();
    }
    return kb;
}


bot.command('start', async (ctx) => {
    await ctx.reply(
        'Salom! Stadion band qilish botiga xush kelibsiz 👋\nSana tanlang:', {
            reply_markup: dayPickerKb()
        }
    );
});


bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        'Qanday ishlaydi?\n\n1) Sana va soatni tanlang.\n2) Ism Familiya va telefon raqamingizni yuboring.\n3) Tasdiqlang — hammasi shu!\n\nBekor qilish: boshlanishiga kamida 3 soat qolgan bo‘lsa, "Mening bandlarim" → ❌ orqali bekor qilishingiz mumkin.'
    );
});


// ---- Pick day
bot.callbackQuery(/^day:(\d+)$/, async (ctx) => {
    const add = Number(ctx.match[1]);
    const date = dayjs().add(add, 'day').format('YYYY-MM-DD');
    await ctx.editMessageText(`Sana: ${date}\nSoat tanlang:`, {
        reply_markup: slotKeyboard(date)
    });
});

bot.callbackQuery(/^days:(\d+)$/, async (ctx) => {
    const n = Number(ctx.match[1]);
    const start = dayjs();
    let text = 'Sana tanlang:';
    const kb = new InlineKeyboard();
    for (let i = 0; i < n; i++) {
        const d = start.add(i, 'day').format('YYYY-MM-DD');
        kb.text(d, `pickday:${d}`).row();
    }
    await ctx.editMessageText(text, {
        reply_markup: kb
    });
});


bot.callbackQuery(/^pickday:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const date = ctx.match[1];
    await ctx.editMessageText(`Sana: ${date}\nSoat tanlang:`, {
        reply_markup: slotKeyboard(date)
    });
});


// ---- Pick hour → ask FIO + phone
bot.callbackQuery(/^pick:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/, async (ctx) => {
    const [, date, hour] = ctx.match;
    const keyboard = new Keyboard().requestContact('📞 Telefonni ulashish').resized();
    ctx.session.pending = {
        date,
        hour
    };
    ctx.session.fioPending = true;
    await ctx.answerCallbackQuery();
    await ctx.reply('Ism Familiyangizni yuboring (masalan: "Ali Valiyev").');
    await ctx.reply('Keyin telefon raqamingizni ulashing:', {
        reply_markup: keyboard
    });
});

// ---- Capture FIO (text)
bot.on('message:text', async (ctx, next) => {
    if (!ctx.session.fioPending) return next();
    const text = ctx.message.text?.trim();
    if (!text || text.split(' ').length < 2) {
        return ctx.reply('Iltimos, to‘liq Ism Familiyani yuboring.');
    }
    ctx.session.full_name = text;
    ctx.session.fioPending = false;
    return next();
});

// ---- Capture contact → try book atomically
bot.on('message:contact', async (ctx) => {
    const pend = ctx.session.pending;
    if (!pend) return ctx.reply('Avval sana va soatni tanlang.');


    const phone = ctx.message.contact.phone_number;
    const full_name = ctx.session.full_name ||
        `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() ||
        'Ism Familyasiz';


    // Double-check slot available and decrement atomically
    try {
        const ok = db.transaction(() => {
            const can = decrementSlot(pend.date, pend.hour);
            if (!can) return false;
            insertBooking({
                user_id: ctx.from.id,
                full_name,
                phone,
                date: pend.date,
                hour: pend.hour,
                created_at: dayjs().format()
            });
            return true;
        })();


        if (!ok) {
            await ctx.reply('Afsus, bu soat band bo‘lib qoldi. Iltimos, boshqa vaqt tanlang.', {
                reply_markup: {
                    remove_keyboard: true
                }
            });
        } else {
            await ctx.reply(`✅ Band qilindi:\n📅 ${pend.date} 🕒 ${pend.hour}\n👤 ${full_name}\n📞 ${phone}`, {
                reply_markup: {
                    remove_keyboard: true
                }
            });
        }
    } finally {
        ctx.session.pending = null;
        ctx.session.full_name = null;
        ctx.session.fioPending = false;
    }
});

// ---- My bookings
bot.callbackQuery('my:bookings', async (ctx) => {
    const rows = getUserActiveBookings(ctx.from.id);
    if (!rows.length) return ctx.answerCallbackQuery({
        text: 'Sizda faol bandlar yo‘q.',
        show_alert: true
    });
    await ctx.answerCallbackQuery();
    let text = 'Sizning bandlaringiz:\n';
    const kb = new InlineKeyboard();
    for (const b of rows) {
        text += `• ${b.date} ${b.hour}\n`;
        kb.text(`❌ ${b.date} ${b.hour}`, `cancel:${b.id}`).row();
    }
    await ctx.reply(text, {
        reply_markup: kb
    });
});


// ---- Cancel (≥3h before)
bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const b = getBookingById(id);
    if (!b || b.user_id !== ctx.from.id || b.status !== 'confirmed')
        return ctx.answerCallbackQuery({
            text: 'Topilmadi yoki allaqachon bekor qilingan.',
            show_alert: true
        });


    const start = parseDateTime(b.date, b.hour);
    if (dayjs().add(3, 'hour').isAfter(start))
        return ctx.answerCallbackQuery({
            text: 'Kech: bekor qilish faqat 3 soat oldin mumkin.',
            show_alert: true
        });


    cancelBooking(id, 'user');
    await ctx.answerCallbackQuery();
    await ctx.reply('✅ Band bekor qilindi.');
});

// ================= Admin =================
bot.callbackQuery('admin:menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({
        text: 'Ruxsat yo‘q.',
        show_alert: true
    });
    await ctx.answerCallbackQuery();
    const today = dayjs().format('YYYY-MM-DD');
    const kb = new InlineKeyboard()
        .text('Bugungi bandlar', `admin:list:${today}`).row()
        .text('Sana tanlash', `admin:pickday`);
    await ctx.reply('Admin menyusi:', {
        reply_markup: kb
    });
});


bot.callbackQuery(/^admin:list:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({
        text: 'Ruxsat yo‘q.',
        show_alert: true
    });
    const date = ctx.match[1];
    const rows = listBookingsByDate(date);
    await ctx.answerCallbackQuery();
    if (!rows.length) return ctx.reply(`📅 ${date}: bandlar yo‘q.`);
    let text = `📅 ${date} bandlar (status=confirmed ham bo‘lishi mumkin):\n`;
    for (const r of rows) {
        text += `#${r.id} ${r.hour} — ${r.full_name} (${r.phone}) [${r.status}]\n`;
    }
    // Quick block toggles
    const kb = new InlineKeyboard();
    for (const h of hoursList()) kb.text(`⛔/✅ ${h}`, `admin:block:${date}:${h}`).row();
    await ctx.reply(text, {
        reply_markup: kb
    });
});

bot.callbackQuery('admin:pickday', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({
        text: 'Ruxsat yo‘q.',
        show_alert: true
    });
    await ctx.answerCallbackQuery();
    const start = dayjs();
    const kb = new InlineKeyboard();
    for (let i = 0; i < 14; i++) {
        const d = start.add(i, 'day').format('YYYY-MM-DD');
        kb.text(d, `admin:list:${d}`).row();
    }
    await ctx.reply('Sana tanlang:', {
        reply_markup: kb
    });
});


bot.callbackQuery(/^admin:block:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({
        text: 'Ruxsat yo‘q.',
        show_alert: true
    });
    const [, date, hour] = ctx.match;
    const state = toggleBlock(date, hour);
    await ctx.answerCallbackQuery({
        text: state === 1 ? '⛔ Bloklandi' : '✅ Ochildi'
    });
    // Refresh list
    const rows = listBookingsByDate(date);
    let text = `📅 ${date} bandlar (yangilandi):\n`;
    for (const r of rows) text += `#${r.id} ${r.hour} — ${r.full_name} (${r.phone}) [${r.status}]\n`;
    await ctx.editMessageText(text);
});


// ---- start long polling
bot.start();
console.log('Bot started with long polling.');