// src/bot.js
import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard, session } from 'grammy';
import { dayjs, parseDateTime } from './time.js';
import {
  ensureSlots, getSlots, decrementSlot, insertBooking,
  getUserActiveBookings, getBookingById, cancelBooking,
  listBookingsByDate, toggleBlock
} from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

function isAdmin(ctx) { return ADMIN_IDS.has(String(ctx.from?.id)); }

bot.use(session({ initial: () => ({}) }));

const OPEN_HOUR = Number(process.env.OPEN_HOUR || 9);
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 23);

// === helper: slot o‘tmishda-yo‘qligini tekshir
function isFutureSlot(date, hour) {
  const start = parseDateTime(date, hour);
  return dayjs().isBefore(start); // now < slot start
}

// ==== Keyboards ====
function dayPickerKb(showAdmin = false) {
  const kb = new InlineKeyboard()
    .text('Bugun', 'day:0').text('Ertaga', 'day:1').row()
    .text('Keyingi 7 kun', 'days:7').row()
    .text('Mening bandlarim', 'my:bookings').row()
    .text('Yordam', 'help').row();
  if (showAdmin) kb.text('Admin', 'admin:menu').row();
  kb.text('◀️ Orqaga', 'back:root');
  return kb;
}

function slotKeyboard(date) {
  ensureSlots(date);
  // faqat kelajakdagi soatlarni ko‘rsatamiz (agar bugungi sana bo‘lsa)
  const all = getSlots(date); // [{hour, remaining, is_blocked}]
  const visible = all.filter(s => isFutureSlot(date, s.hour));

  const kb = new InlineKeyboard();
  visible.forEach((s, i) => {
    const mark = s.is_blocked ? '⛔️'
      : s.remaining >= 2 ? '🟢2'
      : s.remaining === 1 ? '🟡1'
      : '🔴0';
    kb.text(`${s.hour} ${mark}`, `pick:${date}:${s.hour}`);
    if (i % 2 === 1) kb.row(); // 2 columns
  });

  kb.row().text('◀️ Orqaga', 'back:root');
  return kb;
}

// ==== /start ====
bot.command('start', async (ctx) => {
  const showAdmin = isAdmin(ctx);
  await ctx.reply(
    'Salom! Stadion band qilish botiga xush kelibsiz 👋\nSana tanlang:',
    { reply_markup: dayPickerKb(showAdmin) }
  );
});

// ==== Help ====
bot.callbackQuery('help', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('◀️ Orqaga', 'back:root');
  await ctx.reply(
    'Qanday ishlaydi?\n\n' +
    '1) Sana va soatni tanlang.\n' +
    '2) Ism Familiya yuboring.\n' +
    '3) Keyin telefon raqamingizni ulashing.\n\n' +
    'Bekor qilish: boshlanishiga kamida 3 soat qolganda, "Mening bandlarim" → ❌ orqali bekor qilishingiz mumkin.',
    { reply_markup: kb }
  );
});

// ==== Pick day quick ====
bot.callbackQuery(/^day:(\d+)$/, async (ctx) => {
  const add = Number(ctx.match[1]);
  const date = dayjs().add(add, 'day').format('YYYY-MM-DD');
  await ctx.editMessageText(`Sana: ${date}\nSoat tanlang:`, {
    reply_markup: slotKeyboard(date)
  });
});

// ==== Pick many days ====
bot.callbackQuery(/^days:(\d+)$/, async (ctx) => {
  const n = Number(ctx.match[1]);
  const start = dayjs();
  const kb = new InlineKeyboard();
  for (let i = 0; i < n; i++) {
    const d = start.add(i, 'day').format('YYYY-MM-DD');
    kb.text(d, `pickday:${d}`).row();
  }
  kb.text('◀️ Orqaga', 'back:root');
  await ctx.editMessageText('Sana tanlang:', { reply_markup: kb });
});

// ==== Pick a specific day ====
bot.callbackQuery(/^pickday:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const date = ctx.match[1];
  await ctx.editMessageText(`Sana: ${date}\nSoat tanlang:`, {
    reply_markup: slotKeyboard(date)
  });
});

// ==== Pick hour → ask FIO first, phone later ====
bot.callbackQuery(/^pick:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/, async (ctx) => {
  const [, date, hour] = ctx.match;

  // ⚠️ himoya: o‘tgan soatni bosib yuborgan bo‘lishi mumkin (eski keyboard)
  if (!isFutureSlot(date, hour)) {
    await ctx.answerCallbackQuery({ text: 'Bu soat allaqachon o‘tib ketgan.', show_alert: true });
    // ro‘yxatni yangilab beramiz
    try { await ctx.editMessageReplyMarkup({ reply_markup: slotKeyboard(date) }); } catch {}
    return;
  }

  ctx.session.pending = { date, hour };
  ctx.session.fioPending = true;
  delete ctx.session.full_name;

  await ctx.answerCallbackQuery();
  await ctx.reply('Ism Familiyangizni yuboring (masalan: "Ali Valiyev").');
});

// ==== Handle FIO (then show phone request) ====
bot.on('message:text', async (ctx, next) => {
  if (!ctx.session?.fioPending) return next();

  const text = ctx.message.text?.trim();
  if (!text || text.split(' ').length < 2) {
    return ctx.reply('Iltimos, to‘liq Ism Familiyani yuboring.');
  }

  ctx.session.full_name = text;
  ctx.session.fioPending = false;

  const kb = new Keyboard().requestContact('📞 Telefonni ulashish').resized();
  return ctx.reply('Rahmat! Endi telefon raqamingizni ulashing:', { reply_markup: kb });
});

// ==== Capture contact → book atomically (final guard too) ====
bot.on('message:contact', async (ctx) => {
  const pend = ctx.session?.pending;
  if (!pend) {
    return ctx.reply('Avval sana va soatni tanlang.', { reply_markup: { remove_keyboard: true } });
  }
  if (!ctx.session?.full_name) {
    await ctx.reply('Avval Ism Familiyangizni yuboring.', { reply_markup: { remove_keyboard: true } });
    return;
  }

  // ⚠️ yakuniy himoya: slot start vaqti o‘tgan bo‘lsa, to‘xtatamiz
  if (!isFutureSlot(pend.date, pend.hour)) {
    await ctx.reply('Bu vaqt allaqachon o‘tib ketgan. Iltimos, boshqa vaqt tanlang.', {
      reply_markup: { remove_keyboard: true }
    });
    // UI ni ham yangilab beramiz
    try { await ctx.reply(`Sana: ${pend.date}\nSoat tanlang:`, { reply_markup: slotKeyboard(pend.date) }); } catch {}
    // session tozalash
    ctx.session.pending = null;
    ctx.session.full_name = null;
    ctx.session.fioPending = false;
    return;
  }

  const phone = ctx.message.contact.phone_number;
  const full_name = ctx.session.full_name;

  try {
    const ok = (function tx() {
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
        reply_markup: { remove_keyboard: true }
      });
    } else {
      await ctx.reply(
        `✅ Band qilindi:\n📅 ${pend.date}  🕒 ${pend.hour}\n👤 ${full_name}\n📞 ${phone}`,
        { reply_markup: { remove_keyboard: true } }
      );
    }
  } finally {
    ctx.session.pending = null;
    ctx.session.full_name = null;
    ctx.session.fioPending = false;
  }
});

// ==== My bookings ====
bot.callbackQuery('my:bookings', async (ctx) => {
  const rows = getUserActiveBookings(ctx.from.id);
  if (!rows.length) return ctx.answerCallbackQuery({ text: 'Sizda faol bandlar yo‘q.', show_alert: true });

  await ctx.answerCallbackQuery();
  let text = 'Sizning bandlaringiz:\n';
  const kb = new InlineKeyboard();
  for (const b of rows) {
    text += `• ${b.date} ${b.hour}\n`;
    kb.text(`❌ ${b.date} ${b.hour}`, `cancel:${b.id}`).row();
  }
  kb.text('◀️ Orqaga', 'back:root');
  await ctx.reply(text, { reply_markup: kb });
});

// ==== Cancel (≥3h before) ====
bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const b = getBookingById(id);
  if (!b || b.user_id !== ctx.from.id || b.status !== 'confirmed')
    return ctx.answerCallbackQuery({ text: 'Topilmadi yoki allaqachon bekor qilingan.', show_alert: true });

  const start = parseDateTime(b.date, b.hour);
  if (dayjs().add(3, 'hour').isAfter(start))
    return ctx.answerCallbackQuery({ text: 'Kech: bekor qilish faqat 3 soat oldin mumkin.', show_alert: true });

  cancelBooking(id, 'user');
  await ctx.answerCallbackQuery();
  await ctx.reply('✅ Band bekor qilindi.');
});

// ==== Admin ====
bot.callbackQuery('admin:menu', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q.', show_alert: true });
  await ctx.answerCallbackQuery();
  const today = dayjs().format('YYYY-MM-DD');
  const kb = new InlineKeyboard()
    .text('Bugungi bandlar', `admin:list:${today}`).row()
    .text('Sana tanlash', `admin:pickday`).row()
    .text('◀️ Orqaga', 'back:root');
  await ctx.reply('Admin menyusi:', { reply_markup: kb });
});

bot.callbackQuery(/^admin:list:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q.', show_alert: true });
  const date = ctx.match[1];
  const rows = listBookingsByDate(date);
  await ctx.answerCallbackQuery();
  if (!rows.length) {
    const kbEmpty = new InlineKeyboard().text('◀️ Orqaga', 'back:admin');
    return ctx.reply(`📅 ${date}: bandlar yo‘q.`, { reply_markup: kbEmpty });
  }
  let text = `📅 ${date} bandlar:\n`;
  for (const r of rows) text += `#${r.id} ${r.hour} — ${r.full_name} (${r.phone}) ${r.status ? '✅' : '❌'}\n`;
  const kb = new InlineKeyboard().text('◀️ Orqaga', 'back:admin');
  await ctx.reply(text, { reply_markup: kb });
});

bot.callbackQuery('admin:pickday', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q.', show_alert: true });
  await ctx.answerCallbackQuery();
  const start = dayjs();
  const kb = new InlineKeyboard();
  for (let i = 0; i < 14; i++) {
    const d = start.add(i, 'day').format('YYYY-MM-DD');
    kb.text(d, `admin:list:${d}`).row();
  }
  kb.text('◀️ Orqaga', 'back:admin');
  await ctx.reply('Sana tanlang:', { reply_markup: kb });
});

bot.callbackQuery(/^admin:block:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q.', show_alert: true });
  const [, date, hour] = ctx.match;
  const state = toggleBlock(date, hour);
  await ctx.answerCallbackQuery({ text: state === 1 ? '⛔ Bloklandi' : '✅ Ochildi' });
  const rows = listBookingsByDate(date);
  let text = `📅 ${date} bandlar (yangilandi):\n`;
  for (const r of rows) text += `#${r.id} ${r.hour} — ${r.full_name} (${r.phone}) [${r.status}]\n`;
  try {
    await ctx.editMessageText(text);
  } catch {
    const kb = new InlineKeyboard().text('◀️ Orqaga', 'back:admin');
    await ctx.reply(text, { reply_markup: kb });
  }
});

// ==== Back handlers ====
bot.callbackQuery('back:root', async (ctx) => {
  try {
    await ctx.editMessageText('Sana tanlang:', { reply_markup: dayPickerKb(isAdmin(ctx)) });
  } catch {
    await ctx.reply('Sana tanlang:', { reply_markup: dayPickerKb(isAdmin(ctx)) });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('back:admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q.', show_alert: true });
  const today = dayjs().format('YYYY-MM-DD');
  const kb = new InlineKeyboard()
    .text('Bugungi bandlar', `admin:list:${today}`).row()
    .text('Sana tanlash', `admin:pickday`).row()
    .text('◀️ Orqaga', 'back:root');
  try {
    await ctx.editMessageText('Admin menyusi:', { reply_markup: kb });
  } catch {
    await ctx.reply('Admin menyusi:', { reply_markup: kb });
  }
  await ctx.answerCallbackQuery();
});

// ==== start long polling
bot.start();
console.log('Bot started with long polling.');
