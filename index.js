const express = require("express");
const axios = require("axios");
const path = require("path");
const app = express();
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────────
const TOKEN = "EAAST7Y5o9b0BRQmXq21AepqpGRuAfr4iPWQZB1TZC3an1X88vTye9aS2pKkm2pAN6b0wRsxfHbVTrFZBcbDMH0aZAPXivhtBXc5OwmgmAUSipjwBuZABLEyuHFZARZAWuC3iVL2kocytNvZCUZC85z9LXUAwK3E608ZCuOmNUv7E1GND7k1KsG49Ujwzw3T7QrlkgVWgZDZD";
const PHONE_NUMBER_ID = "1119391667920272";
const VERIFY_TOKEN = "washkart_verify_123";
const ADMIN_NUMBER = "917775066002";
const GEMINI_KEY = "AIzaSyA0IB4vHNBnqbUTH5CUgsxmc7OL3CM_AH4";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhdXN2eWJwcWF3eGxheXlxeGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMjE3NzYsImV4cCI6MjA5MjU5Nzc3Nn0.GWqlExeEX1VHAPFQ_YBJrFsOSFb5RS_ZZdxkDTMjjCM";
const DB = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

// ── DB ───────────────────────────────────────────────────────────
async function dbInsert(t, d) { return (await axios.post(`${DB}/${t}`, d, { headers: SB_HEADERS })).data; }
async function dbSelect(t, f) { return (await axios.get(`${DB}/${t}?${f}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(t, f, d) { return (await axios.patch(`${DB}/${t}?${f}`, d, { headers: SB_HEADERS })).data; }

// ── SESSIONS (in-memory + Supabase backup) ───────────────────────
const sessions = {};
const processedMessages = new Set();

function normalizePhone(p) {
  p = p.replace(/\D/g, "");
  if (p.startsWith("91") && p.length === 12) return p;
  if (p.length === 10) return "91" + p;
  return p;
}

function getSession(phone) {
  phone = normalizePhone(phone);
  if (!sessions[phone]) sessions[phone] = { step: "idle", booking: {}, history: [] };
  return sessions[phone];
}

// ── DATE UTILS ───────────────────────────────────────────────────
function formatDate(d) { return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getToday() { return formatDate(new Date()); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate()+1); return formatDate(d); }
function getDayAfter() { const d = new Date(); d.setDate(d.getDate()+2); return formatDate(d); }

function isThursdayStr(str) {
  if (!str) return false;
  const s = str.toLowerCase();
  if (s.includes("thursday") || s.includes("guruvar") || s.includes("veervar")) return true;
  // Parse actual date
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime()) && d.getDay() === 4) return true;
  } catch {}
  return false;
}
function isTodayThursday() { return new Date().getDay() === 4; }
function isTomorrowThursday() { const d = new Date(); d.setDate(d.getDate()+1); return d.getDay() === 4; }

function calcDeliveryDate(service, express) {
  const hours = { iron: express?4:36, laundry: express?4:72, dryclean: express?4:96, shoes: express?4:48, mixed: express?4:96 };
  const h = hours[service] || 72;
  const d = new Date();
  d.setHours(d.getHours() + h);
  if (d.getDay() === 4) d.setDate(d.getDate() + 1);
  return formatDate(d);
}

function genOrderId() {
  const ts = Date.now().toString().slice(-4);
  const rand = Math.floor(100 + Math.random() * 900);
  return `FW-${ts}${rand}`;
}
function normalize(t) { return t.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " "); }
function has(t, ...words) { return words.some(w => t.includes(w)); }

// ── KEYWORD GROUPS ───────────────────────────────────────────────
const BOOKING_KW   = ["pickup","book","schedule","kapde","dhulai","collect","dhobi","booking","pickup karna","mera kapda","pickup chahiye","pickup karo","book karo","order karo","seva","laundry","washing","press karo","istri","dry clean karo"];
const GREET_KW     = ["hi","hello","hey","hii","helo","namaste","kem cho","namaskar","good morning","good evening","good afternoon","wassup","hola","jai shree","radhe","sat sri"];
const PRICE_KW     = ["price","rate","rates","cost","charge","how much","rate list","pricing","charges","kitna","kitne","paisa","kitna lagega","kitne mein","kitna hoga","bata","kya rate","rate kya","price kya","kya charge","kya lagega","lagega kitna","kiti","rupaye","dar","fees","fee"];
const TRACK_KW     = ["track","status","order","kahan","kab","delivery","kab aayega","kab milega","order status","check order","kitna time","kab tak","time lagega","kitna waqt","delivery time","how long","eta","where is","when will","order track","kapda kahan","kiti vel","keva milel"];
const CANCEL_KW    = ["cancel","cancellation","band karo","nahi chahiye","cancel karo","booking cancel","order cancel","raddh","cancel karna"];
const EXPRESS_KW   = ["express","urgent","jaldi","fast","4 hour","same day","asap","jaldi chahiye","urgent hai"];
const HELP_KW      = ["help","menu","options","kya kar sakte","what can","commands","guide","info"];
const IRON_KW      = ["iron","ironing","press","pressing","istri","istr","steam"];
const DC_KW        = ["dry clean","dryclean","dry-clean","drycleaning","dry cleaning","dc","chemical"];
const WASH_KW      = ["wash","laundry","washing","dhona","dhulai","fold","machine wash"];
const SHOE_KW      = ["shoe","shoes","sneaker","sneakers","boot","chappal","sandal","footwear","juta","joote"];
const HOUSEHOLD_KW = ["bedsheet","blanket","curtain","sofa","carpet","bed sheet","chadar","razai","parda"];
const YES_KW       = ["yes","haan","ha","haa","ji","ok","okay","theek","theek hai","sahi","bilkul","zaroor","sure","correct","right","same","confirm","ho","ho ja","kar do","book karo","yes please"];
const NO_KW        = ["no","nahi","na","nope","mat karo","cancel","nhi","nahin","band karo"];

// ── STATUS CONFIG ─────────────────────────────────────────────────
const STATUS_MAP = {
  pending:        { label: "⏳ Pending pickup",    eta: "Our team will pick up within your selected slot." },
  picked:         { label: "🚗 Picked up",          eta: "Clothes picked up! Cleaning starts soon." },
  inprogress:     { label: "🫧 In Progress",        eta: "Your clothes are being cleaned carefully." },
  outfordelivery: { label: "🚚 Out for Delivery",   eta: "Your clothes are on the way!" },
  delivered:      { label: "✅ Delivered",          eta: "Thank you for choosing Washkart! 🙏" },
  cancelled:      { label: "❌ Cancelled",          eta: "This order was cancelled." },
};

const STATUS_UPDATES = {
  picked:         "🚗 *Your clothes have been picked up!*\n\nWe'll start cleaning them right away. 💚",
  inprogress:     "🫧 *Your clothes are being cleaned!*\n\nSit back and relax — we're taking great care of them. ✨",
  outfordelivery: "🚚 *Your order is out for delivery!*\n\nExpect your fresh clothes very soon! 😊",
  delivered:      "✅ *Your clothes have been delivered!*\n\nThank you for choosing Washkart! 🙏\n\nHow was your experience? Reply with ⭐ to ⭐⭐⭐⭐⭐",
};

// ── ITEM PRICE MAP ────────────────────────────────────────────────
const ITEM_MAP = [
  [["normal iron","sada iron","simple iron","plain iron"], "Normal Iron", 10],
  [["urgent iron","express iron","jaldi iron"], "Urgent Iron", 20],
  [["steam iron","bhap","steam press"], "Steam Iron", 20],
  [["kurta iron","kurta press","kurti iron","kurti press"], "Kurta/Kurti Iron", 20],
  [["shawl iron","shawl press","dupatta iron","dupatta press"], "Shawl/Dupatta Iron", 40],
  [["saree iron","saree press","sari iron","sari press"], "Saree Iron", 60],
  [["anarkali iron","anarkali press"], "Anarkali Iron", 20],
  [["lehenga iron","lehnga iron","lehenga press"], "Lehenga Iron", 100],
  [["blazer iron","blazer press","coat iron","jacket iron"], "Blazer/Coat Iron", 100],
  [["bedsheet iron","bed sheet iron","chadar iron"], "Bedsheet Iron", 40],
  [["roll press","roll iron"], "Roll Press", 120],
  [["shirt iron","shirt press"], "Shirt Iron", 20],
  [["pant iron","trouser iron","pant press"], "Pant/Trouser Iron", 20],
  [["shirt dry","shirt clean","shirt dc"], "Shirt Dry Clean", 70],
  [["trouser dry","pant dry","trouser clean","pant clean"], "Trouser/Pant Dry Clean", 70],
  [["jeans dry","jeans clean","jeans dc"], "Jeans Dry Clean", 70],
  [["tshirt dry","t shirt dry","tshirt clean"], "T-Shirt Dry Clean", 70],
  [["kurta dry","kurta clean","kurta dc"], "Kurta Dry Clean", 150],
  [["suit 2","2 piece","2pc suit"], "Suit 2pc Dry Clean", 250],
  [["suit 3","3 piece","3pc suit"], "Suit 3pc Dry Clean", 350],
  [["blazer dry","blazer clean","coat dry","coat clean"], "Blazer Dry Clean", 275],
  [["jacket dry","jacket clean","jacket dc"], "Jacket Dry Clean", 200],
  [["puffer jacket","puffer dry","winter jacket"], "Puffer Jacket Dry Clean", 250],
  [["leather jacket","leather coat"], "Leather Jacket Dry Clean", 350],
  [["sweater dry","sweater clean","woolen dry","sweatshirt dry"], "Sweater Dry Clean", 200],
  [["jodhpuri dry","sherwani dry","sherwani clean"], "Jodhpuri/Sherwani Dry Clean", 300],
  [["nawabi","nawab suit"], "Nawabi Suit Dry Clean", 350],
  [["saree dry","saree clean","saree dc","sari dry","sari clean"], "Saree Dry Clean", 300],
  [["saree work","work saree","embroidery saree","designer saree","heavy saree"], "Saree Work Dry Clean", 400],
  [["saree silk","silk saree","silk sari","pure silk"], "Saree Silk Dry Clean", 350],
  [["blouse dry","blouse clean","blouse dc"], "Blouse Dry Clean", 70],
  [["anarkali dry","anarkali clean","anarkali dc"], "Anarkali Dry Clean", 200],
  [["lehenga dry","lehenga clean","lehnga dry","lehnga clean"], "Lehenga Dry Clean", 350],
  [["lehenga heavy","heavy lehenga","bridal lehenga","wedding lehenga"], "Lehenga Heavy Dry Clean", 450],
  [["dress dry","dress clean","frock dry","frock clean"], "Dress Dry Clean", 175],
  [["dress gown","gown dry","gown clean","evening gown"], "Dress Gown Dry Clean", 300],
  [["kurti dry","kurti clean","kurti dc"], "Kurti Dry Clean", 90],
  [["dupatta dry","dupatta clean","chunni dry"], "Dupatta Dry Clean", 150],
  [["skirt dry","skirt clean"], "Skirt Dry Clean", 90],
  [["plazo dry","palazzo dry","plazo clean"], "Plazo Dry Clean", 100],
  [["scarf dry","scarf clean","muffler dry","stole dry"], "Scarf/Stole Dry Clean", 100],
  [["night wear","nightwear","nighty dry","nighty clean"], "Night Wear Dry Clean", 150],
  [["dhoti dry","dhoti clean"], "Dhoti Dry Clean", 150],
  [["legging dry","legging clean"], "Legging Dry Clean", 70],
  [["blanket wash","razai wash","blanket clean"], "Blanket Wash", 250],
  [["curtain wash","parda wash","curtain clean"], "Curtain Wash", 300],
  [["sofa cover","sofa wash","sofa clean"], "Sofa Cover Wash", 150],
  [["carpet wash","carpet clean","carpet dhona"], "Carpet Wash", 300],
  [["wash fold","fold wash","wash and fold"], "Wash & Fold", 59],
  [["wash iron","washing iron","wash and iron"], "Wash & Iron", 79],
  [["bedsheet wash","bed sheet wash","chadar wash"], "Bedsheet Wash", 120],
  [["sneaker","sneakers","canvas shoe","white shoe"], "Sneakers Cleaning", 300],
  [["leather shoe","formal shoe","oxford"], "Leather Shoes Cleaning", 400],
  [["slide","slides","slipper clean","chappal clean"], "Slides Cleaning", 200],
  [["sports shoe","running shoe","gym shoe"], "Sports Shoes Cleaning", 250],
];

// ── MOBILE-FRIENDLY RATES ─────────────────────────────────────────
const RATES = {
  iron:
    "🔥 *IRONING RATES*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👕 Normal — ₹10 | ⚡ Urgent — ₹20\n" +
    "💨 Steam — ₹20 | 👔 Shirt/Pant — ₹20\n" +
    "👘 Kurta/Kurti — ₹20\n" +
    "🧣 Shawl/Dupatta — ₹40\n" +
    "🥻 Saree — ₹60 | 💃 Anarkali — ₹20\n" +
    "👗 Lehenga — ₹100 | 🧥 Blazer — ₹100\n" +
    "🛏 Bedsheet — ₹40 | 🔄 Roll Press — ₹120\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚡ Express (4–8hr) = 1.5x price\n" +
    "⚠️ Rates may vary by cloth quality",

  dryclean:
    "🧥 *DRY CLEAN — MEN*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👔 Shirt/Trouser/Jeans/T-Shirt — ₹70\n" +
    "👘 Kurta — ₹150 | 👔 Tie — ₹70\n" +
    "🧥 Blazer — ₹250–300\n" +
    "👔 Suit 2pc — ₹250 | Suit 3pc — ₹350\n" +
    "🧶 Sweater — ₹200 | Vest — ₹150\n" +
    "🧥 Jacket — ₹200 | Puffer — ₹250\n" +
    "🥋 Leather Jacket — ₹350\n" +
    "👘 Jodhpuri — ₹300 | Nawabi — ₹350\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👗 *DRY CLEAN — WOMEN*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👚 Blouse/Top/T-Shirt — ₹70\n" +
    "👘 Kurti — ₹90 | Skirt — ₹90\n" +
    "👖 Legging — ₹70 | Plazo — ₹100\n" +
    "🧣 Dupatta — ₹150 | Scarf — ₹100\n" +
    "🥻 Saree — ₹300 | Saree Work — ₹400\n" +
    "🥻 Saree Silk — ₹350\n" +
    "💃 Anarkali — ₹200\n" +
    "👗 Lehenga — ₹350 | Heavy — ₹450\n" +
    "👗 Dress — ₹150–200 | Gown — ₹300\n" +
    "🧶 Sweater — ₹150 | Night Wear — ₹150\n" +
    "━━━━━━━━━━━━━━━\n" +
    "🏠 *HOUSEHOLD DRY CLEAN*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "🪟 Curtains — ₹10/pc\n" +
    "🛌 Single Blanket — ₹300\n" +
    "🛌 Double Blanket — ₹400\n" +
    "👜 Hand Bag — ₹400 | Shawl — ₹150\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚡ Express (4–8hr) = 1.5x price\n" +
    "⚠️ Rates may vary by cloth quality & work",

  laundry:
    "🫧 *LAUNDRY / WASHING*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👕 Wash & Fold — ₹59/kg\n" +
    "🧺 Wash & Iron — ₹79/kg\n" +
    "🛏 Bedsheet — ₹120/kg\n" +
    "🛌 Blanket — ₹250/kg\n" +
    "🪟 Curtain — ₹300/kg\n" +
    "🛋 Sofa Cover — ₹150/kg\n" +
    "🪣 Carpet — ₹300/kg\n" +
    "━━━━━━━━━━━━━━━\n" +
    "📦 Minimum 1kg\n" +
    "🚚 Free pickup above ₹300\n" +
    "⚡ Express (4–8hr) = 1.5x price\n" +
    "⚠️ Rates may vary by cloth quality",

  shoes:
    "👟 *SHOE CLEANING*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👟 Sneakers — ₹300/pair\n" +
    "👞 Leather Shoes — ₹400/pair\n" +
    "🩴 Slides — ₹200/pair\n" +
    "🏃 Sports Shoes — ₹250/pair\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚡ Express (4–8hr) = 1.5x price\n" +
    "⚠️ Rates may vary by condition",
};

const HELP_MSG =
  "🧺 *Washkart — What I can do*\n" +
  "━━━━━━━━━━━━━━━\n" +
  "📦 *Book pickup* — type 'pickup' or just tell me when\n" +
  "💰 *Rates* — type 'rates' or ask any item\n" +
  "🔍 *Track order* — type 'track' or 'kahan hai'\n" +
  "❌ *Cancel* — type 'cancel'\n" +
  "⚡ *Express* — type 'express' after pickup\n" +
  "🔄 *Repeat booking* — type 'same as last time'\n" +
  "━━━━━━━━━━━━━━━\n" +
  "Or just chat naturally — I understand Hindi, Marathi & English! 😊\n" +
  "Closed on *Thursdays* 🙏";

// ── SEND HELPERS ──────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch(e) { console.error("sendMessage error:", e?.response?.data || e.message); }
}
async function sendButtons(to, body, buttons) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "interactive",
        interactive: { type: "button", body: { text: body },
          action: { buttons: buttons.slice(0,3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0,20) } })) }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch(e) { console.error("sendButtons error:", e?.response?.data || e.message); }
}

// ── DB HELPERS ────────────────────────────────────────────────────
async function getCustomer(phone) {
  try { const r = await dbSelect("customers", `phone=eq.${normalizePhone(phone)}`); return r[0] || null; } catch { return null; }
}
async function saveCustomer(phone, name, address) {
  phone = normalizePhone(phone);
  try {
    const ex = await getCustomer(phone);
    if (ex) await dbUpdate("customers", `phone=eq.${phone}`, { name, address });
    else await dbInsert("customers", { phone, name, address });
  } catch(e) { console.error("saveCustomer:", e.message); }
}
async function saveBooking(booking) {
  try {
    await dbInsert("bookings", {
      order_id: booking.orderId, name: booking.name, phone: normalizePhone(booking.phone),
      address: booking.address, date: booking.date, slot: booking.slot,
      status: "pending", reminder_sent: false
    });
  } catch(e) { console.error("saveBooking:", e.message); }
}
async function getActiveOrder(phone) {
  try {
    const rows = await dbSelect("bookings", `phone=eq.${normalizePhone(phone)}&status=neq.delivered&status=neq.cancelled&order=created_at.desc&limit=1`);
    return rows[0] || null;
  } catch { return null; }
}
async function getLastOrder(phone) {
  try {
    const rows = await dbSelect("bookings", `phone=eq.${normalizePhone(phone)}&order=created_at.desc&limit=3`);
    return rows.find(o => o.status !== "cancelled") || null;
  } catch { return null; }
}

// ── ADMIN NOTIFICATION ────────────────────────────────────────────
async function notifyAdmin(booking) {
  await sendMessage(ADMIN_NUMBER,
    `🔔 *New Booking!*\n\n` +
    `🆔 ${booking.orderId}\n` +
    `👤 ${booking.name}\n` +
    `📱 +${booking.phone}\n` +
    `📍 ${booking.address}\n` +
    `📅 ${booking.date}\n` +
    `🕐 ${booking.slot}`
  );
}
async function notifyAdminComplaint(phone, name, message) {
  await sendMessage(ADMIN_NUMBER,
    `⚠️ *Customer Complaint!*\n\n` +
    `👤 ${name || "Unknown"}\n` +
    `📱 +${phone}\n\n` +
    `💬 "${message}"\n\n` +
    `_Please follow up with the customer._`
  );
}

// ── CONFIRM BOOKING ───────────────────────────────────────────────
async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  booking.orderId = orderId; booking.phone = phone;
  await saveBooking(booking);
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n` +
    `🆔 Order ID: *${orderId}*\n` +
    `👤 ${booking.name}\n` +
    `📍 ${booking.address}\n` +
    `📅 ${booking.date}\n` +
    `🕐 ${booking.slot}\n\n` +
    `Our team will arrive within your slot. 💚\n` +
    `💰 Payment via UPI/Cash at delivery.\n\n` +
    `To cancel anytime: type *cancel*`
  );
  await notifyAdmin(booking);
}

// ── ESTIMATE CALCULATOR ───────────────────────────────────────────
const ITEM_PRICES = {
  shirt: {dryclean:70,iron:20,laundry:79},
  pant: {dryclean:70,iron:20,laundry:79},
  trouser: {dryclean:70,iron:20,laundry:79},
  jeans: {dryclean:70,iron:20,laundry:79},
  tshirt: {dryclean:70,iron:20,laundry:79},
  kurta: {dryclean:150,iron:20,laundry:79},
  kurti: {dryclean:90,iron:20,laundry:79},
  saree: {dryclean:300,iron:60,laundry:120},
  lehenga: {dryclean:350,iron:100},
  blazer: {dryclean:275,iron:100},
  jacket: {dryclean:200,iron:100},
  sweater: {dryclean:200,iron:40},
  dress: {dryclean:175,iron:40},
  dupatta: {dryclean:150,iron:40},
  suit: {dryclean:250,iron:100},
  sneakers: {shoes:300},
  "leather shoes": {shoes:400},
  "sports shoes": {shoes:250},
  slides: {shoes:200},
  bedsheet: {laundry:120,iron:40},
  blanket: {laundry:250},
  curtain: {laundry:300},
};
function calcEstimate(items) {
  let total = 0; let breakdown = []; let unknown = [];
  for (const item of items) {
    const name = item.name.toLowerCase().trim();
    const service = item.service || "dryclean";
    const qty = item.qty || 1;
    const found = ITEM_PRICES[name]?.[service];
    if (found) {
      total += found * qty;
      breakdown.push(`${qty}x ${item.name} (${service}) — ₹${found * qty}`);
    } else {
      unknown.push(item.name);
    }
  }
  return { total, breakdown, unknown };
}

// ── SMART PRICE LOOKUP ────────────────────────────────────────────
function smartPriceLookup(t) {
  for (const [keywords, name, price] of ITEM_MAP) {
    if (keywords.some(k => t.includes(k))) return { name, price };
  }
  return null;
}

// ── ASK DATE / SLOT HELPERS ───────────────────────────────────────
async function askDate(phone) {
  const buttons = [];
  if (!isTodayThursday()) buttons.push({ id: "date_today", title: "Today" });
  if (!isTomorrowThursday()) buttons.push({ id: "date_tomorrow", title: "Tomorrow" });
  buttons.push({ id: "date_custom", title: "📆 Other date" });
  await sendButtons(phone, "📅 Which day works for pickup?\n\n_(We are closed on Thursdays)_", buttons);
}
async function askSlot(phone) {
  const hour = new Date().getHours();
  // If after 9am, morning slot is no longer available
  const buttons = [];
  if (hour < 9) buttons.push({ id: "slot_morning", title: "🌅 10 AM – 1 PM" });
  buttons.push({ id: "slot_evening", title: "🌆 5 PM – 8 PM" });
  // If after 4pm, evening slot is also gone — only next day
  if (hour >= 16) {
    await sendMessage(phone, "All slots for today are done 😊\n\nPlease choose *Tomorrow* for pickup!");
    await askDate(phone);
    return;
  }
  const note = hour >= 9 && hour < 16
    ? "🕐 Morning slot is no longer available today.\n\nEvening slot (5–8 PM) is available:"
    : "🕐 Pick your time slot:";
  await sendButtons(phone, note, buttons);
}
async function askPriceCategory(phone) {
  await sendButtons(phone, "💰 Which service rates?",
    [{ id: "price_iron", title: "🔥 Ironing" }, { id: "price_dc", title: "🧥 Dry Clean" }, { id: "price_wash", title: "🫧 Laundry" }]
  );
  setTimeout(async () => {
    await sendButtons(phone, "👇 More:", [{ id: "price_shoe", title: "👟 Shoe Cleaning" }, { id: "btn_book", title: "📦 Book Pickup" }]);
  }, 600);
}

// ── GEMINI AI — NATURAL CONVERSATION BRAIN ────────────────────────
async function geminiChat(phone, userMessage, session, customer, activeOrder, lastOrder) {
  const history = (session.history || []).slice(-6); // last 6 messages for context

  const today = getToday();
  const tomorrow = getTomorrow();
  const dayafter = getDayAfter();

  const systemPrompt = `You are Washkart Assistant — a friendly WhatsApp laundry booking bot for Washkart Laundry in Pimpri, Maharashtra, India.

IMPORTANT RULES:
1. Reply in the SAME language the customer uses (Hindi/Marathi/Hinglish/English)
2. Keep replies SHORT — max 3-4 lines. Conversational, friendly, use emojis
3. Never use formal language — talk like a helpful friend
4. We are CLOSED on Thursdays — if customer asks for Thursday, suggest another day
5. Never make up prices — use only the rates given below

CUSTOMER INFO:
- Name: ${customer?.name || "New customer"}
- Address: ${customer?.address || "Not saved yet"}
- Active order: ${activeOrder ? `${activeOrder.order_id} — ${STATUS_MAP[activeOrder.status]?.label} — ${activeOrder.date} ${activeOrder.slot}` : "None"}
- Last order: ${lastOrder ? `${lastOrder.date} | ${lastOrder.slot} | ${lastOrder.address}` : "None"}

TODAY'S DATES:
- Today: ${today} ${isTodayThursday() ? "(THURSDAY — CLOSED)" : ""}
- Tomorrow: ${tomorrow} ${isTomorrowThursday() ? "(THURSDAY — CLOSED)" : ""}
- Day after: ${dayafter}

BOOKING STATE (what we have so far):
- Name: ${session.booking?.name || "❌ missing"}
- Address: ${session.booking?.address || "❌ missing"}
- Date: ${session.booking?.date || "❌ missing"}
- Slot: ${session.booking?.slot || "❌ missing"}

SERVICES & RATES:
- Ironing: Normal ₹10, Urgent ₹20, Steam ₹20, Saree ₹60, Lehenga ₹100, Blazer ₹100
- Dry Clean Men: Shirt/Pant/Jeans ₹70, Kurta ₹150, Suit 2pc ₹250, Suit 3pc ₹350, Blazer ₹275, Jacket ₹200, Sweater ₹200
- Dry Clean Women: Saree ₹300, Saree Work ₹400, Saree Silk ₹350, Lehenga ₹350, Heavy Lehenga ₹450, Kurti ₹90, Anarkali ₹200, Dress ₹175
- Laundry: Wash & Fold ₹59/kg, Wash & Iron ₹79/kg, Bedsheet ₹120/kg, Blanket ₹250/kg
- Shoes: Sneakers ₹300, Leather ₹400, Sports ₹250, Slides ₹200
- Express (4hr delivery): 1.5x price, not available Thursdays
- Free pickup & delivery above ₹300, Payment UPI/Cash at delivery

RESPOND WITH A JSON object:
{
  "reply": "your friendly reply to customer",
  "action": "none" | "book_now" | "need_name" | "need_address" | "need_date" | "need_slot" | "show_price_category" | "show_iron" | "show_dryclean" | "show_laundry" | "show_shoes" | "track_order" | "cancel_order" | "complaint" | "estimate",
  "extracted": {
    "name": "extracted name or null",
    "address": "extracted address or null",
    "date": "today/tomorrow/DATESTRING or null",
    "slot": "morning/evening or null",
    "items": [{"name":"item","qty":1,"service":"dryclean"}] or null
  }
}

BOOKING LOGIC — BE AGGRESSIVE AT DETECTING INTENT:
- ANY message with pickup/book/laundry/wash/kapde/dhobi/istri/press/dry clean = booking intent
- "Kal subah pickup" = booking, date:tomorrow, slot:morning → action: need_date or book_now
- "Aaj evening" = booking, date:today, slot:evening
- "Pickup karna hai" = booking, need date
- "Kapde dene hain" = booking
- "Kal 6 baje" = booking, date:tomorrow, slot:evening (6pm = evening)
- "Subah pickup" = booking, slot:morning
- "Shaam ko aao" = booking, slot:evening
- For returning customers (has saved name+address): only need date+slot → go straight to need_date
- If all 4 collected (name+address+date+slot) → action: "book_now"
- If missing name → action: "need_name"
- If missing address → action: "need_address"
- If missing date → action: "need_date"
- If missing slot → action: "need_slot"
- "Same as last time" → use last order date+slot, action: "book_now" if possible

COMPLAINT DETECTION:
- If customer complains about quality, damage, stain, wrong item, late delivery → action: "complaint"

ESTIMATE:
- If customer lists items and asks for price → action: "estimate"

CONVERSATION HISTORY:
${history.map(h => `${h.role}: ${h.text}`).join("\n")}

Return ONLY the JSON, no markdown, no explanation.`;

  try {
    const res = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nCustomer message: "${userMessage}"` }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
    });
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error("Gemini error:", e?.response?.data || e.message);
    return { reply: null, action: "none", extracted: {} };
  }
}

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────
async function handleMessage(phone, rawText) {
  phone = normalizePhone(phone);
  const session = getSession(phone);
  const t = normalize(rawText);
  const text = rawText;

  // Add to conversation history
  if (!session.history) session.history = [];
  session.history.push({ role: "customer", text: rawText });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  // ── Price category buttons ──
  if (text === "price_iron")  { await sendMessage(phone, RATES.iron); return; }
  if (text === "price_dc")    { await sendMessage(phone, RATES.dryclean); return; }
  if (text === "price_wash")  { await sendMessage(phone, RATES.laundry); return; }
  if (text === "price_shoe")  { await sendMessage(phone, RATES.shoes); return; }

  // ── Help command ──
  if (has(t, ...HELP_KW)) { await sendMessage(phone, HELP_MSG); return; }

  // ── Voice note ──
  if (rawText === "__audio__") {
    await sendMessage(phone, "Sorry, I can't process voice notes 😊 Please type your message and I'll help right away!");
    return;
  }

  // ── Cancellation ──
  if (has(t, ...CANCEL_KW) && session.step !== "confirm_cancel") {
    const match = rawText.match(/FW-\d+/i);
    const active = await getActiveOrder(phone);
    const orderId = match ? match[0].toUpperCase() : active?.order_id;
    if (orderId) {
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          if (["delivered","cancelled"].includes(rows[0].status)) {
            await sendMessage(phone, `Order *${orderId}* cannot be cancelled — it's already ${STATUS_MAP[rows[0].status]?.label}.`);
          } else {
            await sendButtons(phone,
              `Cancel order *${orderId}*?\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`,
              [{ id: `cc_${orderId}`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ Keep it" }]
            );
            session.step = "confirm_cancel";
          }
        } else {
          await sendMessage(phone, "No active order found. Type *pickup* to book! 🧺");
        }
      } catch { await sendMessage(phone, "Couldn't process. Try again."); }
    } else {
      await sendMessage(phone, "No active orders found. Type *pickup* to book! 🧺");
    }
    return;
  }
  if (session.step === "confirm_cancel") {
    if (text.startsWith("cc_")) {
      const orderId = text.replace("cc_", "");
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`).catch(() => []);
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
      await sendMessage(phone, `✅ Order *${orderId}* cancelled. Type *pickup* to book again! 🧺`);
      await sendMessage(ADMIN_NUMBER, `❌ *Cancelled*\n🆔 ${orderId}\n👤 ${rows[0]?.name}\n📅 ${rows[0]?.date}`);
    } else if (text === "no_cancel") {
      await sendMessage(phone, "Got it! Your order is still active. 👍");
    } else {
      // They typed something else during confirm_cancel — re-prompt
      await sendButtons(phone, "Cancel your order?",
        [{ id: `cc_active`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ Keep it" }]);
      return;
    }
    session.step = "idle"; return;
  }

  // ── Tracking ──
  if (has(t, ...TRACK_KW)) {
    const match = rawText.match(/FW-\d+/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
          const delivery = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
          await sendMessage(phone, `🆔 *${orderId}*\n${s.label}${delivery}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        } else {
          await sendMessage(phone, "Order not found. Please check the ID.");
        }
      } catch { await sendMessage(phone, "Couldn't fetch status. Try again."); }
      return;
    }
    const active = await getActiveOrder(phone);
    if (active) {
      const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
      const delivery = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
      await sendMessage(phone, `📦 *Your Order*\n\n🆔 ${active.order_id}\n${s.label}${delivery}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
      return;
    }
    session.step = "tracking";
    await sendMessage(phone, "🔍 Share your Order ID (e.g. FW-1234):"); return;
  }
  if (session.step === "tracking") {
    const match = rawText.match(/FW-\d+/i);
    if (match) {
      const rows = await dbSelect("bookings", `order_id=eq.${match[0].toUpperCase()}`).catch(() => []);
      if (rows.length) {
        const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
        await sendMessage(phone, `🆔 *${rows[0].order_id}*\n${s.label}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
      } else {
        await sendMessage(phone, "Order not found. Please check the ID.");
      }
      session.step = "idle"; return;
    }
    await sendMessage(phone, "Please share a valid Order ID like *FW-1234*."); return;
  }

  // ── Express ──
  if (has(t, ...EXPRESS_KW) && session.step === "idle") {
    const active = await getActiveOrder(phone);
    if (active && active.status === "picked") {
      if (isTodayThursday()) {
        await sendMessage(phone, "Express service is not available on Thursdays 🙏\nYour order will be delivered on standard timeline.");
        return;
      }
      await sendMessage(phone,
        `⚡ *Express Confirmed!*\n\n` +
        `Your clothes will be cleaned & delivered within *4–8 hours!* 🙌\n` +
        `💰 Express charges apply (1.5x) — final bill at delivery.\n\n` +
        `🆔 ${active.order_id}`
      );
      await dbUpdate("bookings", `order_id=eq.${active.order_id}`, { express: true });
      await sendMessage(ADMIN_NUMBER, `⚡ *Express Requested!*\n🆔 ${active.order_id}\n👤 ${active.name}\n📱 +${active.phone}`);
      return;
    }
    await sendMessage(phone, "Express can be requested after clothes are picked up. Type *pickup* to book first! 🧺");
    return;
  }

  // ── Smart price lookup (item named directly, no quantity) ──
  const hasQuantity = /\d+\s*(shirt|pant|saree|kurta|jeans|piece|pc|kapde|suit|dress|jacket|shoes|pair)/i.test(rawText);
  const itemResult = !hasQuantity ? smartPriceLookup(t) : null;
  if (itemResult && !has(t, ...BOOKING_KW) && !has(t, ...TRACK_KW)) {
    await sendMessage(phone,
      `💰 *${itemResult.name}*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `Standard — ₹${itemResult.price}\n` +
      `⚡ Express (4–8hr) — ₹${Math.ceil(itemResult.price * 1.5)}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `⚠️ Final rate may vary by cloth quality\n` +
      `Type *pickup* to book! 🧺`
    );
    return;
  }

  // ── Date/slot button handlers (still support buttons as backup) ──
  if (text === "date_today") {
    if (isTodayThursday()) { await sendMessage(phone, "We're closed today (Thursday) 🙏 Please choose another day!"); await askDate(phone); return; }
    session.booking.date = getToday(); session.step = "select_slot"; await askSlot(phone); return;
  }
  if (text === "date_tomorrow") {
    if (isTomorrowThursday()) { await sendMessage(phone, "We're closed tomorrow (Thursday) 🙏 Please choose another day!"); await askDate(phone); return; }
    session.booking.date = getTomorrow(); session.step = "select_slot"; await askSlot(phone); return;
  }
  if (text === "date_custom") { session.step = "get_custom_date"; await sendMessage(phone, "📅 Type your preferred date (e.g. *28 April*)\n\n_(Closed Thursdays)_"); return; }
  if (session.step === "get_custom_date") {
    if (isThursdayStr(rawText)) { await sendMessage(phone, "Sorry, we're closed on Thursdays 🙏\n\nPlease choose another date:"); return; }
    session.booking.date = rawText; session.step = "select_slot"; await askSlot(phone); return;
  }
  if (text === "slot_morning") { session.booking.slot = "Morning (10 AM – 1 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); return; }
  if (text === "slot_evening") { session.booking.slot = "Evening (5 PM – 8 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); return; }
  if (text === "use_saved") {
    const saved = await getCustomer(phone);
    session.booking.name = saved.name; session.booking.address = saved.address;
    session.step = "select_date"; await askDate(phone); return;
  }
  if (text === "update_details") { session.booking = {}; session.step = "get_address"; await sendMessage(phone, "📍 Send me your new pickup address:"); return; }
  if (text === "btn_book") { session.step = "idle"; session.booking = {}; }
  if (text === "btn_price") { await askPriceCategory(phone); return; }
  if (text === "btn_track") {
    const active = await getActiveOrder(phone);
    if (active) {
      const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
      await sendMessage(phone, `📦 *Your Order*\n\n🆔 ${active.order_id}\n${s.label}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
    } else { session.step = "tracking"; await sendMessage(phone, "🔍 Share your Order ID:"); }
    return;
  }

  // ── NATURAL AI CONVERSATION ───────────────────────────────────
  const customer = await getCustomer(phone);
  const active = await getActiveOrder(phone);
  const lastOrder = await getLastOrder(phone);

  // Pre-check: if message clearly contains booking intent keywords, set booking mode
  if (has(t, ...BOOKING_KW)) {
    if (!session.booking) session.booking = {};
    if (customer && !session.booking.name) session.booking.name = customer.name;
    if (customer && !session.booking.address) session.booking.address = customer.address;
  }

  // For returning customer saying yes/haan — check what we're waiting for
  if (has(t, ...YES_KW) && session.step === "idle" && customer && session.booking?.date && session.booking?.slot) {
    // They confirmed a smart booking suggestion
    await confirmBooking(phone, session.booking);
    session.booking = {};
    return;
  }

  const ai = await geminiChat(phone, rawText, session, customer, active, lastOrder);
  console.log("AI action:", ai.action, "| extracted:", JSON.stringify(ai.extracted));

  // Extract info from AI into session
  if (ai.extracted?.name && !session.booking?.name) session.booking.name = ai.extracted.name;
  if (ai.extracted?.address && !session.booking?.address) session.booking.address = ai.extracted.address;
  if (ai.extracted?.date) {
    if (ai.extracted.date === "today") session.booking.date = getToday();
    else if (ai.extracted.date === "tomorrow") session.booking.date = getTomorrow();
    else session.booking.date = ai.extracted.date;
    // Validate Thursday
    if (isThursdayStr(session.booking.date)) {
      session.booking.date = null;
      await sendMessage(phone, "We're closed on Thursdays 🙏\n\n" + (ai.reply || "Please choose another day!"));
      return;
    }
  }
  if (ai.extracted?.slot === "morning") session.booking.slot = "Morning (10 AM – 1 PM)";
  if (ai.extracted?.slot === "evening") session.booking.slot = "Evening (5 PM – 8 PM)";

  // For returning customers — use saved details if not provided
  if (customer && !session.booking.name) session.booking.name = customer.name;
  if (customer && !session.booking.address) session.booking.address = customer.address;

  // Handle AI actions
  switch(ai.action) {
    case "book_now":
      // Check for duplicate active order
      if (active && active.status !== "cancelled") {
        await sendMessage(phone,
          `You already have an active order *${active.order_id}* (${STATUS_MAP[active.status]?.label}).\n\n` +
          `Want to cancel it first? Type *cancel* or track it by typing *track*.`
        );
        return;
      }
      if (session.booking.name && session.booking.address && session.booking.date && session.booking.slot) {
        if (ai.reply) await sendMessage(phone, ai.reply);
        await confirmBooking(phone, session.booking);
        session.booking = {};
      }
      break;

    case "need_name":
      session.step = "get_name_ai";
      await sendMessage(phone, ai.reply || "What's your name? 😊");
      break;

    case "need_address":
      session.step = "get_address_ai";
      await sendMessage(phone, ai.reply || "What's your pickup address? 📍");
      break;

    case "need_date":
      if (ai.reply) await sendMessage(phone, ai.reply);
      await askDate(phone);
      session.step = "select_date";
      break;

    case "need_slot":
      if (ai.reply) await sendMessage(phone, ai.reply);
      await askSlot(phone);
      session.step = "select_slot";
      break;

    case "show_price_category":
      if (ai.reply) await sendMessage(phone, ai.reply);
      await askPriceCategory(phone);
      break;

    case "show_iron":    await sendMessage(phone, RATES.iron); break;
    case "show_dryclean": await sendMessage(phone, RATES.dryclean); break;
    case "show_laundry": await sendMessage(phone, RATES.laundry); break;
    case "show_shoes":   await sendMessage(phone, RATES.shoes); break;

    case "track_order":
      if (active) {
        const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
        const delivery = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
        await sendMessage(phone, `📦 *Your Order*\n\n🆔 ${active.order_id}\n${s.label}${delivery}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
      } else {
        await sendMessage(phone, ai.reply || "No active orders found. Type *pickup* to book! 🧺");
      }
      break;

    case "complaint":
      await sendMessage(phone, ai.reply || "I'm really sorry to hear that 🙏 We'll make sure to fix this. Our team will follow up with you shortly.");
      await notifyAdminComplaint(phone, customer?.name, rawText);
      break;

    case "estimate":
      if (ai.extracted?.items && ai.extracted.items.length > 0) {
        const { total, breakdown, unknown } = calcEstimate(ai.extracted.items);
        if (total > 0) {
          let msg = `💰 *Estimate*\n━━━━━━━━━━━━━━━\n`;
          breakdown.forEach(l => msg += `${l}\n`);
          msg += `━━━━━━━━━━━━━━━\n*Total: ₹${total}*\n⚡ Express: ₹${Math.ceil(total*1.5)}`;
          if (unknown.length) msg += `\n\n⚠️ Couldn't estimate: ${unknown.join(", ")}`;
          msg += `\n\n_Final bill may vary_\n\nType *pickup* to book! 🧺`;
          await sendMessage(phone, msg);
        } else {
          await sendMessage(phone, ai.reply || "Let me help! Type the service (e.g. 'dry clean rates') for exact pricing 😊");
        }
      } else {
        await sendMessage(phone, ai.reply || "Sure! Tell me the items and service (e.g. '3 shirts dry clean, 2 jeans') and I'll estimate 😊");
      }
      break;

    default:
      if (ai.reply) await sendMessage(phone, ai.reply);
      else await sendButtons(phone,
        "Hi! 👋 How can I help?\n\nJust tell me what you need — or choose below:",
        [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
      );
  }

  // Handle AI-guided text input steps
  if (session.step === "get_name_ai" && !has(t, ...BOOKING_KW) && !has(t, ...GREET_KW)) {
    session.booking.name = rawText;
    await saveCustomer(phone, rawText, session.booking.address || "");
    session.step = "idle";
  }
  if (session.step === "get_address_ai" && rawText.length > 5) {
    session.booking.address = rawText;
    if (session.booking.name) await saveCustomer(phone, session.booking.name, rawText);
    session.step = "idle";
  }

  // Add AI reply to history
  if (ai.reply) session.history.push({ role: "bot", text: ai.reply });
}

// ── REMINDER SYSTEM ───────────────────────────────────────────────
async function sendReminders() {
  try {
    const today = getToday();
    const rows = await dbSelect("bookings", `date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const hour = new Date().getHours();
    for (const b of rows) {
      if ((b.slot?.includes("Morning") && hour === 8) || (b.slot?.includes("Evening") && hour === 15)) {
        await sendMessage(b.phone,
          `⏰ *Pickup Reminder!*\n\n` +
          `Hi ${b.name}! Your Washkart pickup is *today*.\n\n` +
          `🕐 ${b.slot}\n📍 ${b.address}\n🆔 ${b.order_id}\n\n` +
          `Our team will reach you within the slot. 💚\n` +
          `To cancel: type *cancel*`
        );
        await dbUpdate("bookings", `order_id=eq.${b.order_id}`, { reminder_sent: true });
      }
    }
  } catch(e) { console.error("Reminder error:", e.message); }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ── WEBHOOK ───────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return res.sendStatus(200);
    const msg = messages[0];
    if (processedMessages.has(msg.id)) return res.sendStatus(200);
    processedMessages.add(msg.id);
    setTimeout(() => processedMessages.delete(msg.id), 60000);
    const phone = msg.from;
    if (msg.type === "audio") { await handleMessage(phone, "__audio__"); return res.sendStatus(200); }
    let text = "";
    if (msg.type === "text") text = msg.text.body;
    else if (msg.type === "interactive") {
      text = msg.interactive.type === "button_reply"
        ? msg.interactive.button_reply.id
        : msg.interactive.list_reply.id;
    }
    if (text) await handleMessage(phone, text);
    res.sendStatus(200);
  } catch(err) { console.error(err?.response?.data || err.message); res.sendStatus(200); }
});

// ── DASHBOARD API ─────────────────────────────────────────────────
app.get("/bookings", async (req, res) => {
  try { res.json(await dbSelect("bookings", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch("/bookings/:orderId", async (req, res) => {
  try {
    const { status, service_type, express, delivery_date } = req.body;
    const orderId = req.params.orderId;
    const updateData = { status };
    if (service_type) updateData.service_type = service_type;
    if (express !== undefined) updateData.express = express;
    if (delivery_date) updateData.delivery_date = delivery_date;
    if (service_type && !delivery_date) updateData.delivery_date = calcDeliveryDate(service_type, express || false);
    await dbUpdate("bookings", `order_id=eq.${orderId}`, updateData);
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    const b = rows[0];
    const msgs = {
      picked: `🚗 *Your clothes have been picked up!*\n\n` +
        (b?.service_type ? `🧺 Service: ${b.service_type}\n` : "") +
        (updateData.delivery_date ? `📦 Est. Delivery: *${updateData.delivery_date}*\n` : "") +
        `⚡ Need it urgently? Reply *EXPRESS* for 4–8 hour delivery!\n\n🆔 ${orderId}`,
      inprogress: `🫧 *Your clothes are being cleaned!*\n\nWe're taking great care of them. ✨\n${updateData.delivery_date ? `📦 Est. Delivery: *${updateData.delivery_date}*\n` : ""}🆔 ${orderId}`,
      outfordelivery: `🚚 *Your order is out for delivery!*\n\nFresh clothes on the way! 😊\n🆔 ${orderId}`,
      delivered: `✅ *Your clothes have been delivered!*\n\nThank you for choosing Washkart! 🙏\n\nHow was your experience? Reply with ⭐ to ⭐⭐⭐⭐⭐`,
    };
    if (msgs[status] && b?.phone) {
      await sendMessage(b.phone, msgs[status]);
      if (status === "delivered" && sessions[normalizePhone(b.phone)]) {
        sessions[normalizePhone(b.phone)].step = "feedback";
      }
    }
    res.json({ success: true, delivery_date: updateData.delivery_date });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/customers", async (req, res) => {
  try { res.json(await dbSelect("customers", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart bot running on port ${PORT}`));
